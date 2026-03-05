use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::buffer::EventBuffer;

/// A check configuration received from the Hub
#[derive(Clone, Debug, serde::Deserialize)]
pub struct RemoteCheck {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub check_type: String,
    pub config: serde_json::Value,
    pub interval_seconds: u64,
}

/// WebSocket client that maintains a persistent connection to the Vigil Hub.
pub struct HubClient {
    hub_url: String,
    hub_token: String,
    agent_name: String,
    /// Sends remote check configs from Hub to the monitoring loop
    checks_tx: tokio::sync::watch::Sender<Vec<RemoteCheck>>,
}

impl HubClient {
    pub fn new(hub_url: String, hub_token: String, agent_name: String) -> (Self, tokio::sync::watch::Receiver<Vec<RemoteCheck>>) {
        let (checks_tx, checks_rx) = tokio::sync::watch::channel(vec![]);
        let client = Self { hub_url, hub_token, agent_name, checks_tx };
        (client, checks_rx)
    }

    /// Main loop: connect, register, heartbeat, drain buffer, reconnect on failure.
    pub async fn run(&self, buffer: Arc<Mutex<EventBuffer>>) {
        let mut backoff_secs = 1u64;
        let max_backoff = 60u64;

        loop {
            info!(url = %self.hub_url, "Connecting to Hub");

            match self.connect_and_run(&buffer).await {
                Ok(()) => {
                    info!("Hub connection closed gracefully");
                    backoff_secs = 1;
                }
                Err(e) => {
                    error!(error = %e, backoff_secs, "Hub connection failed");
                }
            }

            warn!(backoff_secs, "Reconnecting to Hub after backoff");
            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
            backoff_secs = (backoff_secs * 2).min(max_backoff);
        }
    }

    async fn connect_and_run(&self, buffer: &Arc<Mutex<EventBuffer>>) -> Result<()> {
        let url = self.hub_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let url = format!("{}/ws/agent", url.trim_end_matches('/'));
        let url = &url;
        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(url)
            .header("Authorization", format!("Bearer {}", self.hub_token))
            .header("Host", extract_host(url))
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            )
            .body(())?;

        let (ws_stream, _response) = connect_async(request).await?;
        let (mut write, mut read) = ws_stream.split();

        info!("Connected to Hub");

        let register = serde_json::json!({
            "type": "register",
            "agent_name": self.agent_name,
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "hostname": sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string()),
        });
        write.send(Message::Text(register.to_string())).await?;

        let heartbeat_interval = Duration::from_secs(30);
        let drain_interval = Duration::from_secs(5);
        let mut heartbeat_timer = tokio::time::interval(heartbeat_interval);
        let mut drain_timer = tokio::time::interval(drain_interval);
        let mut checks_count: u64 = 0;

        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                match val.get("type").and_then(|t| t.as_str()) {
                                    Some("configure_checks") => {
                                        if let Some(checks_val) = val.get("checks") {
                                            if let Ok(checks) = serde_json::from_value::<Vec<RemoteCheck>>(checks_val.clone()) {
                                                info!(count = checks.len(), "Received check configuration from Hub");
                                                // Merge with existing checks (don't replace — Hub may send partial updates)
                                                let mut current = self.checks_tx.borrow().clone();
                                                for new_check in checks {
                                                    if let Some(pos) = current.iter().position(|c| c.id == new_check.id) {
                                                        current[pos] = new_check;
                                                    } else {
                                                        current.push(new_check);
                                                    }
                                                }
                                                self.checks_tx.send(current).ok();
                                            }
                                        }
                                    }
                                    _ => {
                                        info!(msg = %text, "Received from Hub");
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            write.send(Message::Pong(data)).await?;
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            info!("Hub closed connection");
                            return Ok(());
                        }
                        Some(Err(e)) => {
                            return Err(e.into());
                        }
                        _ => {}
                    }
                }

                _ = heartbeat_timer.tick() => {
                    let hb = serde_json::json!({
                        "type": "heartbeat",
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                        "checks_count": checks_count,
                    });
                    write.send(Message::Text(hb.to_string())).await?;
                }

                _ = drain_timer.tick() => {
                    let mut buf = buffer.lock().await;
                    let events = buf.drain(50)?;
                    checks_count += events.len() as u64;
                    for event in events {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&event) {
                            let msg = serde_json::json!({
                                "type": "check_result",
                                "check_name": parsed.get("monitor_name").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "status": parsed.get("status").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "latency_ms": parsed.get("response_time_ms").and_then(|v| v.as_u64()),
                                "message": parsed.get("message").and_then(|v| v.as_str()).unwrap_or(""),
                                "metadata": parsed.get("metadata"),
                                "checked_at": parsed.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""),
                            });
                            write.send(Message::Text(msg.to_string())).await?;
                        } else {
                            write.send(Message::Text(event)).await?;
                        }
                    }
                }
            }
        }
    }
}

fn extract_host(url: &str) -> String {
    url.replace("wss://", "")
        .replace("ws://", "")
        .split('/')
        .next()
        .unwrap_or("localhost")
        .to_string()
}
