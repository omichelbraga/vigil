use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::buffer::EventBuffer;

/// WebSocket client that maintains a persistent connection to the Vigil Hub.
/// Features: token authentication, heartbeats, exponential backoff reconnect,
/// and draining the local SQLite buffer when connected.
pub struct HubClient {
    hub_url: String,
    hub_token: String,
    agent_name: String,
}

impl HubClient {
    pub fn new(hub_url: String, hub_token: String, agent_name: String) -> Self {
        Self {
            hub_url,
            hub_token,
            agent_name,
        }
    }

    /// Main loop: connect, authenticate, heartbeat, drain buffer, reconnect on failure.
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
        let url = format!(
            "{}?token={}&agent={}",
            self.hub_url, self.hub_token, self.agent_name
        );

        let (ws_stream, _response) = connect_async(&url).await?;
        let (mut write, mut read) = ws_stream.split();

        info!("Connected to Hub, starting heartbeat and buffer drain");

        // Send auth message
        let auth_msg = serde_json::json!({
            "type": "auth",
            "token": self.hub_token,
            "agent_name": self.agent_name,
            "version": env!("CARGO_PKG_VERSION"),
        });
        write.send(Message::Text(auth_msg.to_string())).await?;

        let heartbeat_interval = Duration::from_secs(30);
        let drain_interval = Duration::from_secs(5);
        let mut heartbeat_timer = tokio::time::interval(heartbeat_interval);
        let mut drain_timer = tokio::time::interval(drain_interval);

        loop {
            tokio::select! {
                // Receive messages from Hub
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            info!(msg = %text, "Received from Hub");
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

                // Send heartbeat
                _ = heartbeat_timer.tick() => {
                    let hb = serde_json::json!({
                        "type": "heartbeat",
                        "agent_name": self.agent_name,
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    });
                    write.send(Message::Text(hb.to_string())).await?;
                }

                // Drain buffer
                _ = drain_timer.tick() => {
                    let mut buf = buffer.lock().await;
                    let events = buf.drain(50)?;
                    for event in events {
                        write.send(Message::Text(event)).await?;
                    }
                }
            }
        }
    }
}
