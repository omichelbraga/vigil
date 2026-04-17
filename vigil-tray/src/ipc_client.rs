//! Reusable IPC client — same framing as `vigil-agent/src/ipc_client.rs`
//! but decoupled from the agent crate so we don't pull its dep-tree
//! (rusqlite, rustls, etc.) into the tray.
//!
//! Transport:
//!   * Unix — connect to `$VIGIL_IPC_PATH`, else `/run/vigil-agent.sock`,
//!     else `/tmp/vigil-agent.sock`.
//!   * Windows — connect to `$VIGIL_IPC_PATH`, else `\\.\pipe\vigil-agent`.
//!
//! Protocol:
//!   * newline-delimited JSON-RPC 2.0
//!   * every frame is `<=64KiB`
//!   * events are pushed as `{jsonrpc,method:"event",params:{name,data}}`
//!
//! API:
//!   * [`call`] — one round-trip; opens a fresh connection per call so
//!     callers don't have to worry about interleaving.
//!   * [`subscribe`] — keep a connection open, send `subscribe_events`,
//!     forward every `event` frame via an `mpsc::Sender`. Auto-reconnects
//!     with capped exponential backoff — ideal for background task.

use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_util::codec::{Framed, LinesCodec};
use tracing::{debug, warn};

#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

const MAX_FRAME_BYTES: usize = 64 * 1024;

#[cfg(unix)]
const DEFAULT_UNIX_SOCK:  &str = "/run/vigil-agent.sock";
#[cfg(unix)]
const FALLBACK_UNIX_SOCK: &str = "/tmp/vigil-agent.sock";
#[cfg(windows)]
const DEFAULT_WINDOWS_PIPE: &str = r"\\.\pipe\vigil-agent";

// -- transport path --------------------------------------------------------

#[cfg(unix)]
pub fn transport_path() -> String {
    if let Ok(p) = std::env::var("VIGIL_IPC_PATH") {
        if !p.is_empty() {
            return p;
        }
    }
    if std::path::Path::new(DEFAULT_UNIX_SOCK).exists() {
        DEFAULT_UNIX_SOCK.to_string()
    } else {
        FALLBACK_UNIX_SOCK.to_string()
    }
}

#[cfg(windows)]
pub fn transport_path() -> String {
    std::env::var("VIGIL_IPC_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_WINDOWS_PIPE.to_string())
}

// -- single-shot call ------------------------------------------------------

/// One JSON-RPC round-trip. Opens the transport, sends, reads until the
/// first non-event frame (which is the response), returns `result` or
/// propagates `error.message`.
pub async fn call(method: &str, params: Value) -> Result<Value> {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    #[cfg(unix)]
    {
        let path = transport_path();
        let stream = UnixStream::connect(&path)
            .await
            .with_context(|| format!("connect ipc socket {path}"))?;
        do_call(stream, req).await
    }

    #[cfg(windows)]
    {
        let pipe = transport_path();
        let stream = ClientOptions::new()
            .open(&pipe)
            .with_context(|| format!("open named pipe {pipe}"))?;
        do_call(stream, req).await
    }
}

async fn do_call<S>(stream: S, req: Value) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    let mut framed = Framed::new(stream, LinesCodec::new_with_max_length(MAX_FRAME_BYTES));
    framed.send(req.to_string()).await?;
    while let Some(line) = framed.next().await {
        let line = line.context("read ipc response")?;
        let parsed: Value = serde_json::from_str(&line).context("parse ipc response JSON")?;
        if parsed.get("method").and_then(|v| v.as_str()) == Some("event") {
            // Dropped — one-shot calls don't care about events.
            continue;
        }
        if let Some(err) = parsed.get("error") {
            let msg = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("ipc error");
            anyhow::bail!("{}", msg);
        }
        return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
    }
    anyhow::bail!("ipc: connection closed before response")
}

// -- subscription loop -----------------------------------------------------

/// What the subscribe loop feeds back to the app.
#[derive(Debug, Clone)]
pub enum SubEvent {
    Connected,
    Disconnected { reason: String },
    Event { name: String, data: Value },
}

/// Long-lived task: subscribe to `subscribe_events` and forward frames.
/// Auto-reconnects with capped exponential backoff (0.5s -> 30s).
/// Returns only when `tx` is dropped by the receiver.
pub async fn subscribe_loop(tx: mpsc::Sender<SubEvent>) {
    let mut backoff = Duration::from_millis(500);
    loop {
        match connect_and_subscribe(&tx).await {
            Ok(()) => {
                // Clean shutdown — restart immediately with reset backoff.
                backoff = Duration::from_millis(500);
            }
            Err(e) => {
                let reason = e.to_string();
                warn!(error = %reason, "ipc: subscribe loop disconnected, retrying");
                let _ = tx
                    .send(SubEvent::Disconnected { reason })
                    .await;
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
        if tx.is_closed() {
            debug!("ipc: subscribe loop receiver dropped, exiting");
            return;
        }
    }
}

async fn connect_and_subscribe(tx: &mpsc::Sender<SubEvent>) -> Result<()> {
    #[cfg(unix)]
    let mut framed = {
        let path = transport_path();
        let stream = UnixStream::connect(&path)
            .await
            .with_context(|| format!("connect {path}"))?;
        Framed::new(stream, LinesCodec::new_with_max_length(MAX_FRAME_BYTES))
    };
    #[cfg(windows)]
    let mut framed = {
        let pipe = transport_path();
        let stream: NamedPipeClient = ClientOptions::new()
            .open(&pipe)
            .with_context(|| format!("open {pipe}"))?;
        Framed::new(stream, LinesCodec::new_with_max_length(MAX_FRAME_BYTES))
    };

    // Send subscribe request.
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "subscribe_events",
        "params": {},
    });
    framed.send(req.to_string()).await?;

    // First non-event frame is the ack.
    let mut acked = false;

    while let Some(line) = framed.next().await {
        let line = line.context("read frame")?;
        let parsed: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "ipc: bad frame, skipping");
                continue;
            }
        };

        if parsed.get("method").and_then(|v| v.as_str()) == Some("event") {
            let name = parsed
                .pointer("/params/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let data = parsed
                .pointer("/params/data")
                .cloned()
                .unwrap_or(Value::Null);
            if tx.send(SubEvent::Event { name, data }).await.is_err() {
                return Ok(()); // receiver dropped
            }
        } else if !acked {
            acked = true;
            if let Some(err) = parsed.get("error") {
                let msg = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("subscribe failed");
                anyhow::bail!("{}", msg);
            }
            if tx.send(SubEvent::Connected).await.is_err() {
                return Ok(());
            }
        }
    }
    anyhow::bail!("stream closed")
}
