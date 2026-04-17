use anyhow::Result;
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

use crate::buffer::EventBuffer;
use crate::config::AllowActions;
use crate::inventory::AgentInventory;
use crate::resource_sampler::ResourceSample;
use crate::result_signing::{canonical_json, sign_body_hex, ResultSigner};

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

/// Shared map from `check_id` → "silenced until" UTC timestamp. Written by the
/// `silence_check` action handler, read by the main monitor loop which skips
/// any check whose silence entry is still in the future.
pub type SilenceMap = Arc<Mutex<HashMap<String, DateTime<Utc>>>>;

/// Request sent from the hub_client's WS reader to the main monitor loop to
/// run a single check on-demand. Main responds (best-effort) on `done_tx`
/// with an `action_ack` payload so we can wire an ack back to the Hub.
#[derive(Debug)]
pub struct RunNowRequest {
    pub check_id: String,
}

/// Outcome of a run-now request, emitted back by the main loop.
#[derive(Debug)]
pub struct RunNowOutcome {
    pub check_id: String,
    /// "ok" | "unknown_check"
    pub status: &'static str,
}

/// How long a queued `ResourceSample` may sit before we drop it. Resource
/// telemetry is cheap and frequent — if we're disconnected for more than
/// 30 seconds there's no value in backfilling old CPU numbers once we reconnect,
/// and we'd rather not flood the buffer.
const SAMPLE_MAX_AGE: Duration = Duration::from_secs(30);

/// WebSocket client that maintains a persistent connection to the Vigil Hub.
pub struct HubClient {
    hub_url: String,
    hub_token: String,
    agent_name: String,
    config_path: String,
    allow_actions: AllowActions,
    /// Sends remote check configs from Hub to the monitoring loop
    checks_tx: tokio::sync::watch::Sender<Vec<RemoteCheck>>,
    /// Shared silence state — also read by the main monitor loop.
    silence: SilenceMap,
    /// Outbound run-now requests → main loop.
    runnow_tx: mpsc::Sender<RunNowRequest>,
    /// Incoming run-now outcomes from main loop. Wrapped in a Mutex<Option<..>>
    /// because the receiver is `!Sync` and we need to move it into the
    /// connect_and_run loop exactly once per process lifetime.
    runnow_rx: Arc<Mutex<Option<mpsc::Receiver<RunNowOutcome>>>>,
    /// Tracks how many events we've had to drop (sampler backpressure, buffer
    /// overflows, etc.) — reported back to the Hub in `health_report`.
    dropped_events: Arc<AtomicU64>,
    /// Agent start time, used to compute uptime for health reports.
    start: std::time::Instant,
    /// Per-agent ed25519 signer. The Hub pins `public_key_hex` on first
    /// register and verifies every subsequent message's `signature` field.
    signer: Arc<ResultSigner>,
}

/// Extra plumbing exposed to the main loop for action support.
pub struct ActionChannels {
    pub silence: SilenceMap,
    pub runnow_rx: mpsc::Receiver<RunNowRequest>,
    pub runnow_ack_tx: mpsc::Sender<RunNowOutcome>,
    /// A cloneable sender for run-now requests. Exposed so the IPC server
    /// can drop local-originated run-now requests into the same queue the
    /// WS path uses. Kept distinct from the private `runnow_tx` used inside
    /// [`HubClient`] so we don't have to rewire that path.
    pub runnow_tx_for_ipc: mpsc::Sender<RunNowRequest>,
}

impl HubClient {
    pub fn new(
        hub_url: String,
        hub_token: String,
        agent_name: String,
        config_path: String,
        allow_actions: AllowActions,
        signer: Arc<ResultSigner>,
    ) -> (
        Self,
        tokio::sync::watch::Receiver<Vec<RemoteCheck>>,
        ActionChannels,
    ) {
        let (checks_tx, checks_rx) = tokio::sync::watch::channel(vec![]);
        let silence: SilenceMap = Arc::new(Mutex::new(HashMap::new()));
        let (runnow_tx, runnow_rx) = mpsc::channel::<RunNowRequest>(32);
        let (runnow_ack_tx, runnow_ack_rx) = mpsc::channel::<RunNowOutcome>(32);

        let actions = ActionChannels {
            silence: Arc::clone(&silence),
            runnow_rx,
            runnow_ack_tx,
            runnow_tx_for_ipc: runnow_tx.clone(),
        };

        let client = Self {
            hub_url,
            hub_token,
            agent_name,
            config_path,
            allow_actions,
            checks_tx,
            silence,
            runnow_tx,
            runnow_rx: Arc::new(Mutex::new(Some(runnow_ack_rx))),
            dropped_events: Arc::new(AtomicU64::new(0)),
            start: std::time::Instant::now(),
            signer,
        };
        (client, checks_rx, actions)
    }

    /// Shared counter the sampler/monitor code can bump when it has to drop
    /// something (e.g. channel full, buffer overflow). Reported in health_report.
    #[allow(dead_code)]
    pub fn drop_counter(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.dropped_events)
    }

    /// Main loop: connect, register, heartbeat, drain buffer, reconnect on failure.
    pub async fn run(
        &self,
        buffer: Arc<Mutex<EventBuffer>>,
        mut sample_rx: mpsc::Receiver<ResourceSample>,
        inventory: AgentInventory,
    ) {
        let mut backoff_secs = 1u64;
        let max_backoff = 60u64;

        // Take the run-now ack receiver once — we keep it across reconnects.
        let mut runnow_ack_rx = {
            let mut slot = self.runnow_rx.lock().await;
            slot.take().expect("runnow_rx already consumed")
        };

        loop {
            info!(url = %self.hub_url, "Connecting to Hub");

            match self
                .connect_and_run(&buffer, &mut sample_rx, &inventory, &mut runnow_ack_rx)
                .await
            {
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

    async fn connect_and_run(
        &self,
        buffer: &Arc<Mutex<EventBuffer>>,
        sample_rx: &mut mpsc::Receiver<ResourceSample>,
        inventory: &AgentInventory,
        runnow_ack_rx: &mut mpsc::Receiver<RunNowOutcome>,
    ) -> Result<()> {
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
            "protocol_version": crate::PROTOCOL_VERSION,
            "agent_name": self.agent_name,
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "hostname": sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string()),
            "public_key": self.signer.public_key_hex(),
        });
        send_signed(&mut write, register, &self.signer).await?;

        // Send inventory snapshot immediately after register. The Hub upserts
        // by agentId, so repeated sends on reconnect are idempotent and keep
        // the record fresh if hardware changes (disk added, NIC renamed).
        let inventory_msg = serde_json::json!({
            "type": "inventory_report",
            "protocol_version": crate::PROTOCOL_VERSION,
            "inventory": inventory,
        });
        if let Err(e) = send_signed(&mut write, inventory_msg, &self.signer).await {
            warn!(error = %e, "Failed to send inventory_report");
        }

        let heartbeat_interval = Duration::from_secs(30);
        // Drain often + in big batches so the buffer recovers quickly after a
        // reconnect (legacy builds could accumulate thousands of events that
        // starve newer results at the tail of a FIFO queue otherwise).
        let drain_interval = Duration::from_secs(1);
        let health_interval = Duration::from_secs(60);
        let mut heartbeat_timer = tokio::time::interval(heartbeat_interval);
        let mut drain_timer = tokio::time::interval(drain_interval);
        let mut health_timer = tokio::time::interval(health_interval);
        let mut checks_count: u64 = 0;

        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                match msg_type {
                                    "configure_checks" => {
                                        if let Some(checks_val) = val.get("checks") {
                                            if let Ok(checks) = serde_json::from_value::<Vec<RemoteCheck>>(checks_val.clone()) {
                                                info!(count = checks.len(), "Received check configuration from Hub");
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
                                    "run_check_now" => {
                                        let check_id = val
                                            .get("check_id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        if !self.allow_actions.run_check_now {
                                            send_action_denied(&mut write, "run_check_now", &check_id, "disabled by agent allow_actions", &self.signer).await?;
                                        } else if check_id.is_empty() {
                                            send_action_denied(&mut write, "run_check_now", &check_id, "missing check_id", &self.signer).await?;
                                        } else {
                                            // Dispatch to main loop; ack after main replies on runnow_ack_rx.
                                            // Non-blocking: if the channel is full we immediately deny.
                                            match self.runnow_tx.try_send(RunNowRequest { check_id: check_id.clone() }) {
                                                Ok(()) => {
                                                    info!(%check_id, "run_check_now queued");
                                                    // We do NOT wait synchronously — the ack path pushes
                                                    // an action_ack once the monitor loop reports back.
                                                }
                                                Err(e) => {
                                                    warn!(%check_id, error = %e, "run_check_now queue full");
                                                    send_action_denied(&mut write, "run_check_now", &check_id, "queue full", &self.signer).await?;
                                                }
                                            }
                                        }
                                    }
                                    "silence_check" => {
                                        let check_id = val
                                            .get("check_id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        if !self.allow_actions.silence_check {
                                            send_action_denied(&mut write, "silence_check", &check_id, "disabled by agent allow_actions", &self.signer).await?;
                                        } else if check_id.is_empty() {
                                            send_action_denied(&mut write, "silence_check", &check_id, "missing check_id", &self.signer).await?;
                                        } else {
                                            let until_str = val.get("until").and_then(|v| v.as_str());
                                            let mut map = self.silence.lock().await;
                                            let mut ack_status = "ok";
                                            match until_str {
                                                None => {
                                                    // null / absent → unsilence
                                                    map.remove(&check_id);
                                                    info!(%check_id, "silence cleared");
                                                }
                                                Some(s) => {
                                                    match DateTime::parse_from_rfc3339(s) {
                                                        Ok(dt) => {
                                                            let until_utc = dt.with_timezone(&Utc);
                                                            if until_utc <= Utc::now() {
                                                                map.remove(&check_id);
                                                                info!(%check_id, "silence cleared (past timestamp)");
                                                            } else {
                                                                map.insert(check_id.clone(), until_utc);
                                                                info!(%check_id, until = %until_utc, "silence set");
                                                            }
                                                        }
                                                        Err(e) => {
                                                            warn!(%check_id, error = %e, "invalid silence_check 'until'");
                                                            ack_status = "bad_timestamp";
                                                        }
                                                    }
                                                }
                                            }
                                            drop(map);
                                            send_action_ack(&mut write, "silence_check", &check_id, ack_status, &self.signer).await?;
                                        }
                                    }
                                    "reload_config" => {
                                        if !self.allow_actions.reload_config {
                                            send_action_denied(&mut write, "reload_config", "", "disabled by agent allow_actions", &self.signer).await?;
                                        } else {
                                            // Partial reload: parse TOML, then update the fields we
                                            // can swap safely (monitor intervals, resource thresholds).
                                            // We do NOT touch hub_url/hub_token — that would require a reconnect.
                                            match crate::config::Config::load(&self.config_path) {
                                                Ok(_new_cfg) => {
                                                    info!("config reloaded (intervals/resource thresholds will apply on next monitor-set refresh)");
                                                    send_action_ack(&mut write, "reload_config", "", "ok", &self.signer).await?;
                                                }
                                                Err(e) => {
                                                    warn!(error = %e, "reload_config failed");
                                                    send_action_ack(&mut write, "reload_config", "", "parse_error", &self.signer).await?;
                                                }
                                            }
                                        }
                                    }
                                    "" => {
                                        warn!(msg = %text, "Received Hub message without 'type' — ignoring");
                                    }
                                    other => {
                                        warn!(kind = %other, "Unknown Hub message type — ignoring");
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

                // Run-now outcomes from main loop → ack back to Hub.
                Some(outcome) = runnow_ack_rx.recv() => {
                    send_action_ack(&mut write, "run_check_now", &outcome.check_id, outcome.status, &self.signer).await?;
                }

                // Resource telemetry: ship each sample as soon as it's produced.
                // Samples older than SAMPLE_MAX_AGE are discarded (bump drop counter).
                Some(sample) = sample_rx.recv() => {
                    let age = Utc::now().signed_duration_since(sample.timestamp);
                    if age.num_seconds() > SAMPLE_MAX_AGE.as_secs() as i64 {
                        self.dropped_events.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    let msg = serde_json::json!({
                        "type": "resource_sample",
                        "cpu_pct": sample.cpu_pct,
                        "ram_pct": sample.ram_pct,
                        "disk_pct": sample.disk_pct,
                        "load_avg_1": sample.load_avg_1,
                        "net_rx_bps": sample.net_rx_bps,
                        "net_tx_bps": sample.net_tx_bps,
                        "timestamp": sample.timestamp.to_rfc3339(),
                    });
                    if let Err(e) = send_signed(&mut write, msg, &self.signer).await {
                        warn!(error = %e, "Failed to send resource_sample; reconnecting");
                        return Err(e);
                    }
                }

                _ = heartbeat_timer.tick() => {
                    let hb = serde_json::json!({
                        "type": "heartbeat",
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                        "checks_count": checks_count,
                    });
                    send_signed(&mut write, hb, &self.signer).await?;
                }

                _ = health_timer.tick() => {
                    let buffer_depth = {
                        let buf = buffer.lock().await;
                        buf.count().unwrap_or(0)
                    };
                    let uptime_secs = self.start.elapsed().as_secs();
                    let dropped = self.dropped_events.load(Ordering::Relaxed);
                    let hr = serde_json::json!({
                        "type": "health_report",
                        "buffer_depth": buffer_depth,
                        "dropped_events": dropped,
                        "uptime_secs": uptime_secs,
                    });
                    if let Err(e) = send_signed(&mut write, hr, &self.signer).await {
                        warn!(error = %e, "Failed to send health_report");
                    }
                }

                _ = drain_timer.tick() => {
                    let mut buf = buffer.lock().await;
                    let events = buf.drain(500)?;
                    checks_count += events.len() as u64;
                    for event in events {
                        let msg = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&event) {
                            serde_json::json!({
                                "type": "check_result",
                                "check_name": parsed.get("monitor_name").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "status": parsed.get("status").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "latency_ms": parsed.get("response_time_ms").and_then(|v| v.as_u64()),
                                "message": parsed.get("message").and_then(|v| v.as_str()).unwrap_or(""),
                                "metadata": parsed.get("metadata"),
                                "checked_at": parsed.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""),
                            })
                        } else {
                            // Legacy path: event wasn't parseable JSON. Wrap as a
                            // typed check_result with the raw text as message so
                            // it can still be signed.
                            serde_json::json!({
                                "type": "check_result",
                                "check_name": "unknown",
                                "status": "unknown",
                                "message": event,
                            })
                        };
                        send_signed(&mut write, msg, &self.signer).await?;
                    }
                }
            }
        }
    }
}

/// Serialize `body` to canonical JSON, sign it with the agent's ed25519 key,
/// inject the hex signature as `signature: <hex>`, then send over the WS.
///
/// The Hub-side verifier reconstructs the canonical form by stripping the
/// `signature` field and re-canonicalising, so it's important that the
/// signature we attach is computed over the *pre-injection* JSON.
async fn send_signed<S>(
    write: &mut S,
    mut body: serde_json::Value,
    signer: &ResultSigner,
) -> Result<()>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let sig_hex = sign_body_hex(signer, &body);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("signature".to_string(), serde_json::Value::String(sig_hex));
        // Emit in canonical (sorted-key) form too — keeps the wire
        // representation deterministic for log/replay tooling. Not required
        // for verification (the Hub strips `signature` before canonicalising).
        let wire = canonical_json(&body);
        write.send(Message::Text(wire)).await?;
    } else {
        // Non-object payload — shouldn't happen with our builders, but fall
        // back to raw send so we don't silently drop data.
        write.send(Message::Text(body.to_string())).await?;
    }
    Ok(())
}

/// Send an `action_ack` back to the Hub. `status` is a short free-form string
/// ("ok", "unknown_check", "bad_timestamp", …).
async fn send_action_ack<S>(
    write: &mut S,
    action: &str,
    check_id: &str,
    status: &str,
    signer: &ResultSigner,
) -> Result<()>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let msg = serde_json::json!({
        "type": "action_ack",
        "action": action,
        "check_id": check_id,
        "status": status,
    });
    send_signed(write, msg, signer).await
}

async fn send_action_denied<S>(
    write: &mut S,
    action: &str,
    check_id: &str,
    reason: &str,
    signer: &ResultSigner,
) -> Result<()>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let msg = serde_json::json!({
        "type": "action_denied",
        "action": action,
        "check_id": check_id,
        "reason": reason,
    });
    send_signed(write, msg, signer).await
}

fn extract_host(url: &str) -> String {
    url.replace("wss://", "")
        .replace("ws://", "")
        .split('/')
        .next()
        .unwrap_or("localhost")
        .to_string()
}
