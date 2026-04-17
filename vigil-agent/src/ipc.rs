//! Local IPC server for the Vigil agent.
//!
//! Exposes a newline-delimited JSON-RPC 2.0 interface over a Unix domain
//! socket (Linux) or a named pipe (Windows), consumed by the bundled
//! `vigilctl` subcommand and by the tray/HUD binaries.
//!
//! The server keeps handler dispatch small and auditable: one `match` on the
//! method name in [`dispatch`], each method wrapped in its own `tokio::spawn`
//! so a single malformed or panicking request can't take down the listener.
//!
//! Framing: one JSON object per line, `\n`-terminated. Max 64 KiB per frame.
//! Larger frames are rejected with a `-32600 payload too large` error.
//!
//! Event streaming: clients that call `subscribe_events` stop receiving
//! request/response traffic and start receiving server-pushed
//! `{"jsonrpc":"2.0","method":"event","params":{"name":..,"data":..}}`
//! frames until they disconnect.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, info, warn};

use crate::buffer::EventBuffer;
use crate::config::Config;
use crate::hub_client::{RunNowRequest, SilenceMap};

/// Framing cap. Requests or pushed events larger than this are rejected.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// IPC wire protocol version. Bump when the request/response shape changes.
pub const IPC_PROTOCOL_VERSION: u32 = 1;

/// Default socket path on Linux. Falls back to `/tmp/vigil-agent.sock` when
/// `/run` is not writable (common in dev / unprivileged runs).
#[cfg(unix)]
pub const DEFAULT_UNIX_SOCK: &str = "/run/vigil-agent.sock";
#[cfg(unix)]
pub const FALLBACK_UNIX_SOCK: &str = "/tmp/vigil-agent.sock";

/// Default named-pipe endpoint on Windows.
#[cfg(windows)]
pub const DEFAULT_WINDOWS_PIPE: &str = r"\\.\pipe\vigil-agent";

/// Events published by the agent over the broadcast channel. IPC subscribers
/// receive these as `{"method":"event","params":{...}}` JSON-RPC
/// notifications.
#[allow(dead_code)] // some variants are emitted only under specific code paths
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "name", content = "data", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Hub WS connection came up.
    AgentConnected { hub_url: String },
    /// Hub WS connection dropped.
    AgentDisconnected { reason: String },
    /// A check completed (local or remote).
    CheckResult {
        check_id: Option<String>,
        monitor_name: String,
        monitor_type: String,
        status: String,
        response_time_ms: Option<u64>,
        message: String,
    },
    /// Status for a given check id transitioned.
    StatusChange {
        check_id: String,
        from: String,
        to: String,
    },
    /// Local buffer depth is outside a healthy threshold.
    BufferBackpressure { depth: usize, dropped: u64 },
}

/// Monitor metadata the IPC server returns from `list_checks`. We intentionally
/// don't snapshot the live `Box<dyn Monitor>` — the server gets a small Arc
/// of serialisable rows kept up to date by the monitor loop.
#[derive(Clone, Debug, Serialize)]
pub struct CheckRow {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub check_type: String,
    pub target: String,
    pub source: &'static str, // "remote" | "local"
    pub status_last: Option<String>,
    pub latency_last_ms: Option<u64>,
    pub last_checked: Option<DateTime<Utc>>,
    pub silenced_until: Option<DateTime<Utc>>,
}

/// Shared context handed to the IPC listener. All fields are `Arc`/`Clone`
/// so each spawned request handler gets a cheap clone.
#[derive(Clone)]
pub struct IpcContext {
    pub hub_url: String,
    pub agent_name: String,
    pub agent_id: Arc<Mutex<Option<String>>>,
    pub signing_pubkey_hex: String,
    pub connected: Arc<std::sync::atomic::AtomicBool>,
    pub silence: SilenceMap,
    pub runnow_tx: mpsc::Sender<RunNowRequest>,
    pub buffer: Arc<Mutex<EventBuffer>>,
    pub dropped_events: Arc<AtomicU64>,
    pub start: Instant,
    pub config_path: String,
    pub paused_until: Arc<Mutex<Option<DateTime<Utc>>>>,
    pub events_tx: broadcast::Sender<AgentEvent>,
    pub check_rows: Arc<Mutex<Vec<CheckRow>>>,
    pub reload_tx: tokio::sync::watch::Sender<u64>,
    pub log_file_path: Option<PathBuf>,
}

impl IpcContext {
    /// Emit an event on the broadcast channel — best-effort; errors when there
    /// are no subscribers, which is fine.
    #[allow(dead_code)]
    pub fn emit(&self, ev: AgentEvent) {
        let _ = self.events_tx.send(ev);
    }
}

// -- JSON-RPC wire types ---------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct RpcRequest {
    #[serde(default)]
    pub(crate) jsonrpc: String,
    pub(crate) id: Option<Value>,
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) params: Value,
}

#[derive(Serialize)]
struct RpcOk<'a> {
    jsonrpc: &'a str,
    id: Value,
    result: Value,
}

#[derive(Serialize)]
struct RpcErr<'a> {
    jsonrpc: &'a str,
    id: Value,
    error: RpcErrBody<'a>,
}

#[derive(Serialize)]
struct RpcErrBody<'a> {
    code: i32,
    message: &'a str,
}

fn ok_response(id: Value, result: Value) -> String {
    serde_json::to_string(&RpcOk { jsonrpc: "2.0", id, result })
        .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"serialize failed"}}"#.to_string())
}

fn err_response(id: Value, code: i32, message: &str) -> String {
    serde_json::to_string(&RpcErr {
        jsonrpc: "2.0",
        id,
        error: RpcErrBody { code, message },
    })
    .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"serialize failed"}}"#.to_string())
}

// -- method dispatcher -----------------------------------------------------

/// State local to a single connection. Separate from [`IpcContext`] because
/// event subscription is per-connection.
pub(crate) struct ConnState {
    pub subscribed: bool,
}

/// Core dispatcher — returns the RPC response JSON string to send back, or
/// `None` if the method is a one-way subscription that flips conn state.
///
/// Kept small + auditable on purpose: one `match` branch per method.
pub(crate) async fn dispatch(
    ctx: &IpcContext,
    conn: &mut ConnState,
    req: RpcRequest,
) -> Option<String> {
    let id = req.id.unwrap_or(Value::Null);

    // jsonrpc version is advisory — we don't reject missing/odd values,
    // but we log a debug trace for anyone sending the wrong version.
    if !req.jsonrpc.is_empty() && req.jsonrpc != "2.0" {
        debug!(version = %req.jsonrpc, "ipc: non-2.0 jsonrpc version");
    }

    match req.method.as_str() {
        "get_status" => Some(ok_response(id, method_get_status(ctx).await)),
        "list_checks" => Some(ok_response(id, method_list_checks(ctx).await)),
        "run_check_now" => match method_run_check_now(ctx, &req.params).await {
            Ok(v) => Some(ok_response(id, v)),
            Err(e) => Some(err_response(id, -32000, &e.to_string())),
        },
        "silence" => match method_silence(ctx, &req.params).await {
            Ok(v) => Some(ok_response(id, v)),
            Err(e) => Some(err_response(id, -32000, &e.to_string())),
        },
        "pause_all" => match method_pause_all(ctx, &req.params).await {
            Ok(v) => Some(ok_response(id, v)),
            Err(e) => Some(err_response(id, -32000, &e.to_string())),
        },
        "tail_log" => match method_tail_log(ctx, &req.params).await {
            Ok(v) => Some(ok_response(id, v)),
            Err(e) => Some(err_response(id, -32000, &e.to_string())),
        },
        "reload_config" => match method_reload_config(ctx).await {
            Ok(v) => Some(ok_response(id, v)),
            Err(e) => Some(err_response(id, -32000, &e.to_string())),
        },
        "subscribe_events" => {
            conn.subscribed = true;
            Some(ok_response(id, json!({"subscribed": true})))
        }
        other => Some(err_response(
            id,
            -32601,
            &format!("Method not found: {other}"),
        )),
    }
}

async fn method_get_status(ctx: &IpcContext) -> Value {
    let connected = ctx.connected.load(Ordering::Relaxed);
    let agent_id = ctx.agent_id.lock().await.clone();
    let buffer_depth = ctx.buffer.lock().await.count().unwrap_or(0);
    let dropped = ctx.dropped_events.load(Ordering::Relaxed);
    let uptime_secs = ctx.start.elapsed().as_secs();
    let paused_until = ctx.paused_until.lock().await.clone();
    let check_count = ctx.check_rows.lock().await.len();

    let pk_prefix = if ctx.signing_pubkey_hex.len() >= 8 {
        Some(ctx.signing_pubkey_hex[..8].to_string())
    } else {
        None
    };

    json!({
        "connected": connected,
        "hub_url": ctx.hub_url,
        "agent_name": ctx.agent_name,
        "agent_id": agent_id,
        "version": env!("CARGO_PKG_VERSION"),
        "protocol_version": crate::PROTOCOL_VERSION,
        "ipc_protocol_version": IPC_PROTOCOL_VERSION,
        "signing_pubkey_prefix": pk_prefix,
        "buffer_depth": buffer_depth,
        "dropped_events": dropped,
        "uptime_secs": uptime_secs,
        "check_count": check_count,
        "paused_until": paused_until,
    })
}

async fn method_list_checks(ctx: &IpcContext) -> Value {
    let rows = ctx.check_rows.lock().await.clone();
    // Merge silenced_until from the live silence map (authoritative).
    let silence = ctx.silence.lock().await.clone();
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|mut r| {
            if let Some(until) = silence.get(&r.id) {
                if *until > Utc::now() {
                    r.silenced_until = Some(*until);
                }
            }
            serde_json::to_value(r).unwrap_or(Value::Null)
        })
        .collect();
    Value::Array(rows)
}

async fn method_run_check_now(ctx: &IpcContext, params: &Value) -> Result<Value> {
    let check_id = params
        .get("check_id")
        .and_then(|v| v.as_str())
        .context("missing check_id")?
        .to_string();

    match ctx
        .runnow_tx
        .try_send(RunNowRequest {
            check_id: check_id.clone(),
        }) {
        Ok(()) => Ok(json!({"queued": true, "check_id": check_id, "source": "local"})),
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            Ok(json!({"queued": false, "check_id": check_id, "source": "local", "error": "queue full"}))
        }
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
            anyhow::bail!("run-now channel closed")
        }
    }
}

async fn method_silence(ctx: &IpcContext, params: &Value) -> Result<Value> {
    let check_id = params
        .get("check_id")
        .and_then(|v| v.as_str())
        .context("missing check_id")?
        .to_string();

    let until = if let Some(iso) = params.get("until_iso").and_then(|v| v.as_str()) {
        DateTime::parse_from_rfc3339(iso)
            .context("invalid until_iso — expected RFC3339")?
            .with_timezone(&Utc)
    } else if let Some(secs) = params.get("duration_secs").and_then(|v| v.as_u64()) {
        Utc::now() + chrono::Duration::seconds(secs as i64)
    } else {
        anyhow::bail!("either until_iso or duration_secs is required");
    };

    let mut map = ctx.silence.lock().await;
    if until <= Utc::now() {
        map.remove(&check_id);
    } else {
        map.insert(check_id.clone(), until);
    }

    Ok(json!({"ok": true, "until": until.to_rfc3339(), "check_id": check_id}))
}

async fn method_pause_all(ctx: &IpcContext, params: &Value) -> Result<Value> {
    let secs = params
        .get("duration_secs")
        .and_then(|v| v.as_u64())
        .context("missing duration_secs")?;

    let until = Utc::now() + chrono::Duration::seconds(secs as i64);
    *ctx.paused_until.lock().await = Some(until);

    info!(duration_secs = secs, until = %until, "ipc: pause_all");
    Ok(json!({"ok": true, "until": until.to_rfc3339()}))
}

async fn method_tail_log(ctx: &IpcContext, params: &Value) -> Result<Value> {
    let n = params
        .get("lines")
        .and_then(|v| v.as_u64())
        .unwrap_or(50) as usize;

    let Some(ref path) = ctx.log_file_path else {
        return Ok(json!({"lines": [], "source": "journal-unavailable"}));
    };
    if !path.exists() {
        return Ok(json!({"lines": [], "source": "journal-unavailable"}));
    }

    let content = tokio::fs::read_to_string(path).await.unwrap_or_default();
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(n);
    let tail: Vec<String> = lines[start..].iter().map(|s| s.to_string()).collect();

    Ok(json!({"lines": tail, "source": "file"}))
}

async fn method_reload_config(ctx: &IpcContext) -> Result<Value> {
    // Parse the config now so we can report parse errors inline; the monitor
    // loop will re-read on the next tick via the watch signal.
    let _parsed = Config::load(&ctx.config_path)
        .with_context(|| format!("failed to reload {}", ctx.config_path))?;

    let now = Utc::now();
    // Bump the watch value so the monitor loop notices and re-reads.
    let cur = *ctx.reload_tx.borrow();
    let _ = ctx.reload_tx.send(cur.wrapping_add(1));

    info!("ipc: reload_config signalled");
    Ok(json!({"ok": true, "reloaded_at": now.to_rfc3339()}))
}

// -- listener loop ---------------------------------------------------------

/// Entry point. Binds the OS-native transport and serves until
/// `shutdown` resolves.
pub async fn serve(ctx: IpcContext, shutdown: impl std::future::Future<Output = ()>) -> Result<()> {
    tokio::pin!(shutdown);
    #[cfg(unix)]
    {
        serve_unix(ctx, &mut shutdown).await
    }
    #[cfg(windows)]
    {
        serve_windows(ctx, &mut shutdown).await
    }
}

#[cfg(unix)]
async fn serve_unix<F>(ctx: IpcContext, shutdown: &mut std::pin::Pin<&mut F>) -> Result<()>
where
    F: std::future::Future<Output = ()>,
{
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let path = resolve_unix_socket_path();
    // Remove any stale socket.
    let _ = std::fs::remove_file(&path);

    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            warn!(path = %path, error = %e, "ipc: failed to bind primary socket — trying fallback");
            let fb = FALLBACK_UNIX_SOCK;
            let _ = std::fs::remove_file(fb);
            UnixListener::bind(fb).with_context(|| format!("bind ipc socket {fb}"))?
        }
    };

    // 0o660: owner + group rw. Group ownership is whatever the process runs
    // as; operators who want a dedicated `vigil` group can chgrp the socket
    // after start (or use systemd SocketMode=).
    if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)) {
        warn!(error = %e, "ipc: could not set socket permissions");
    }

    info!(path = %path, "ipc: listening on unix socket");

    loop {
        tokio::select! {
            _ = &mut *shutdown => {
                info!("ipc: shutdown");
                let _ = std::fs::remove_file(&path);
                return Ok(());
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _addr)) => {
                        let ctx2 = ctx.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream, ctx2).await {
                                debug!(error = %e, "ipc: connection ended with error");
                            }
                        });
                    }
                    Err(e) => {
                        warn!(error = %e, "ipc: accept failed");
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
fn resolve_unix_socket_path() -> String {
    if let Ok(p) = std::env::var("VIGIL_IPC_PATH") {
        if !p.is_empty() {
            return p;
        }
    }
    // Use /run if it's writable, otherwise fall back to /tmp.
    let run_dir = std::path::Path::new("/run");
    if run_dir.exists() {
        // We can't easily test writability without touching a file, but the
        // bind() attempt above will fall back on its own if this fails.
        return DEFAULT_UNIX_SOCK.to_string();
    }
    FALLBACK_UNIX_SOCK.to_string()
}

#[cfg(windows)]
async fn serve_windows<F>(ctx: IpcContext, shutdown: &mut std::pin::Pin<&mut F>) -> Result<()>
where
    F: std::future::Future<Output = ()>,
{
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = std::env::var("VIGIL_IPC_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_WINDOWS_PIPE.to_string());

    info!(pipe = %pipe_name, "ipc: listening on named pipe");

    // First instance — the spawn-next-instance pattern recommended by tokio
    // docs: every accept() re-creates the next instance so concurrent clients
    // don't race each other.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .with_context(|| format!("create named pipe {pipe_name}"))?;

    loop {
        tokio::select! {
            _ = &mut *shutdown => {
                info!("ipc: shutdown");
                return Ok(());
            }
            connect_res = server.connect() => {
                if let Err(e) = connect_res {
                    warn!(error = %e, "ipc: pipe connect failed");
                    // Re-create and keep going
                    server = ServerOptions::new()
                        .create(&pipe_name)
                        .with_context(|| format!("recreate named pipe {pipe_name}"))?;
                    continue;
                }

                // Hand the connected instance off to a handler, and create a
                // new one immediately for the next client.
                let this_conn = server;
                server = ServerOptions::new()
                    .create(&pipe_name)
                    .with_context(|| format!("recreate named pipe {pipe_name}"))?;

                let ctx2 = ctx.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(this_conn, ctx2).await {
                        debug!(error = %e, "ipc: connection ended with error");
                    }
                });
            }
        }
    }
}

async fn handle_connection<S>(stream: S, ctx: IpcContext) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    use futures_util::{SinkExt, StreamExt};
    use tokio_util::codec::{Framed, LinesCodec, LinesCodecError};

    let codec = LinesCodec::new_with_max_length(MAX_FRAME_BYTES);
    let mut framed = Framed::new(stream, codec);
    let mut conn = ConnState { subscribed: false };

    // If the client subscribes, we need to push events to it. Grab a
    // receiver lazily on first subscribe so non-subscribers don't take up
    // broadcast slots.
    let mut event_rx: Option<broadcast::Receiver<AgentEvent>> = None;

    loop {
        tokio::select! {
            incoming = framed.next() => {
                match incoming {
                    Some(Ok(line)) => {
                        // Parse inside a spawn-safe closure so a malformed
                        // request can't propagate into the accept loop.
                        let resp = match serde_json::from_str::<RpcRequest>(&line) {
                            Ok(req) => dispatch(&ctx, &mut conn, req).await,
                            Err(e) => Some(err_response(
                                Value::Null,
                                -32700,
                                &format!("parse error: {e}"),
                            )),
                        };
                        if let Some(text) = resp {
                            if let Err(e) = framed.send(text).await {
                                debug!(error = %e, "ipc: send failed (client gone)");
                                return Ok(());
                            }
                        }
                        // If the client subscribed on this request, attach
                        // the broadcast receiver for subsequent loop turns.
                        if conn.subscribed && event_rx.is_none() {
                            event_rx = Some(ctx.events_tx.subscribe());
                        }
                    }
                    Some(Err(LinesCodecError::MaxLineLengthExceeded)) => {
                        let resp = err_response(Value::Null, -32600, "payload too large");
                        let _ = framed.send(resp).await;
                        return Ok(());
                    }
                    Some(Err(e)) => {
                        debug!(error = %e, "ipc: read error");
                        return Ok(());
                    }
                    None => {
                        // Client closed
                        return Ok(());
                    }
                }
            }

            // If subscribed, forward events.
            ev = async {
                if let Some(rx) = event_rx.as_mut() {
                    rx.recv().await
                } else {
                    // Park forever when not subscribed.
                    std::future::pending().await
                }
            } => {
                match ev {
                    Ok(event) => {
                        let msg = json!({
                            "jsonrpc": "2.0",
                            "method": "event",
                            "params": event,
                        });
                        let line = msg.to_string();
                        if line.len() > MAX_FRAME_BYTES {
                            debug!("ipc: skipping oversized event frame");
                            continue;
                        }
                        if let Err(e) = framed.send(line).await {
                            debug!(error = %e, "ipc: event send failed (client gone)");
                            return Ok(());
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        debug!(lagged = n, "ipc: broadcast lagged");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        return Ok(());
                    }
                }
            }
        }
    }
}

// -- helpers available to the agent's main loop ---------------------------

/// Helper — returns the initial empty check-rows Arc used to seed a context.
pub fn new_check_rows() -> Arc<Mutex<Vec<CheckRow>>> {
    Arc::new(Mutex::new(Vec::new()))
}

/// Helper — paused map starts empty.
pub fn new_paused_until() -> Arc<Mutex<Option<DateTime<Utc>>>> {
    Arc::new(Mutex::new(None))
}

/// Helper — allocate a `(tx, _)` pair for the IPC event broadcast.
pub fn new_event_channel(capacity: usize) -> broadcast::Sender<AgentEvent> {
    let (tx, _rx) = broadcast::channel(capacity);
    tx
}

/// Build a best-effort `CheckRow` from a hub_client::RemoteCheck.
pub fn row_from_remote(c: &crate::hub_client::RemoteCheck) -> CheckRow {
    // Pick the most useful "target" field per check type so operators can
    // see at a glance what each check points at.
    let target = match c.check_type.as_str() {
        "http" => c
            .config
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "port" => format!(
            "{}:{}",
            c.config.get("host").and_then(|v| v.as_str()).unwrap_or(""),
            c.config.get("port").and_then(|v| v.as_u64()).unwrap_or(0)
        ),
        "ping" | "cert" | "service" => c
            .config
            .get("host")
            .and_then(|v| v.as_str())
            .or_else(|| c.config.get("name").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        "process" => c
            .config
            .get("process_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "logfile" => c
            .config
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "event_log" => c
            .config
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    };
    CheckRow {
        id: c.id.clone(),
        name: c.name.clone(),
        check_type: c.check_type.clone(),
        target,
        source: "remote",
        status_last: None,
        latency_last_ms: None,
        last_checked: None,
        silenced_until: None,
    }
}

/// Update (or insert) the latest result for a given check id.
pub async fn record_check_result(
    rows: &Arc<Mutex<Vec<CheckRow>>>,
    id: Option<&str>,
    monitor_name: &str,
    monitor_type: &str,
    status: &str,
    latency_ms: Option<u64>,
    at: DateTime<Utc>,
) {
    let mut rows = rows.lock().await;
    // Match by id when we have one (remote checks), otherwise match by
    // monitor_name (config-file checks have no id).
    let idx = if let Some(id) = id {
        rows.iter().position(|r| r.id == id)
    } else {
        rows.iter().position(|r| r.name == monitor_name && r.source == "local")
    };
    match idx {
        Some(i) => {
            rows[i].status_last = Some(status.to_string());
            rows[i].latency_last_ms = latency_ms;
            rows[i].last_checked = Some(at);
        }
        None if id.is_none() => {
            rows.push(CheckRow {
                id: format!("local:{monitor_name}"),
                name: monitor_name.to_string(),
                check_type: monitor_type.to_string(),
                target: String::new(),
                source: "local",
                status_last: Some(status.to_string()),
                latency_last_ms: latency_ms,
                last_checked: Some(at),
                silenced_until: None,
            });
        }
        None => { /* unknown remote id — the remote list will refresh shortly */ }
    }
}

/// Unit tests (no-agent; pure request/response round-trips).
#[cfg(test)]
mod tests {
    use super::*;

    /// Build a dummy context and return both it and the run-now receiver so
    /// tests can keep the receiver alive for the duration of the test body.
    fn dummy_ctx() -> (IpcContext, mpsc::Receiver<RunNowRequest>) {
        use std::collections::HashMap;
        let (runnow_tx, rx) = mpsc::channel(8);
        let buffer = Arc::new(Mutex::new(
            EventBuffer::new(":memory:").expect("tmp buffer"),
        ));
        let ctx = IpcContext {
            hub_url: "wss://hub.example/ws".to_string(),
            agent_name: "testagent".to_string(),
            agent_id: Arc::new(Mutex::new(Some("agent-xyz".to_string()))),
            signing_pubkey_hex: "deadbeefcafef00d".to_string(),
            connected: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            silence: Arc::new(Mutex::new(HashMap::new())),
            runnow_tx,
            buffer,
            dropped_events: Arc::new(AtomicU64::new(0)),
            start: Instant::now(),
            config_path: "config.toml".into(),
            paused_until: new_paused_until(),
            events_tx: new_event_channel(16),
            check_rows: new_check_rows(),
            reload_tx: tokio::sync::watch::channel(0u64).0,
            log_file_path: None,
        };
        (ctx, rx)
    }

    #[tokio::test]
    async fn status_shape() {
        let (ctx, _rx) = dummy_ctx();
        let v = method_get_status(&ctx).await;
        assert_eq!(v["agent_name"], "testagent");
        assert_eq!(v["hub_url"], "wss://hub.example/ws");
        assert_eq!(v["connected"], true);
        assert!(v["version"].is_string());
        assert_eq!(v["signing_pubkey_prefix"], "deadbeef");
    }

    #[tokio::test]
    async fn list_checks_empty() {
        let (ctx, _rx) = dummy_ctx();
        let v = method_list_checks(&ctx).await;
        assert!(v.is_array());
        assert_eq!(v.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn run_check_now_queues() {
        let (ctx, _rx) = dummy_ctx();
        let v = method_run_check_now(&ctx, &json!({"check_id": "abc"}))
            .await
            .unwrap();
        assert_eq!(v["queued"], true);
        assert_eq!(v["check_id"], "abc");
        assert_eq!(v["source"], "local");
    }

    #[tokio::test]
    async fn run_check_now_missing_id() {
        let (ctx, _rx) = dummy_ctx();
        let err = method_run_check_now(&ctx, &json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn silence_duration() {
        let (ctx, _rx) = dummy_ctx();
        let v = method_silence(&ctx, &json!({"check_id": "c1", "duration_secs": 60}))
            .await
            .unwrap();
        assert_eq!(v["ok"], true);
        assert!(v["until"].is_string());
        assert!(ctx.silence.lock().await.contains_key("c1"));
    }

    #[tokio::test]
    async fn silence_past_iso_clears() {
        let (ctx, _rx) = dummy_ctx();
        ctx.silence
            .lock()
            .await
            .insert("c1".into(), Utc::now() + chrono::Duration::seconds(10));
        let v = method_silence(
            &ctx,
            &json!({"check_id": "c1", "until_iso": "2000-01-01T00:00:00Z"}),
        )
        .await
        .unwrap();
        assert_eq!(v["ok"], true);
        assert!(!ctx.silence.lock().await.contains_key("c1"));
    }

    #[tokio::test]
    async fn pause_all_sets_until() {
        let (ctx, _rx) = dummy_ctx();
        let v = method_pause_all(&ctx, &json!({"duration_secs": 30}))
            .await
            .unwrap();
        assert_eq!(v["ok"], true);
        assert!(ctx.paused_until.lock().await.is_some());
    }

    #[tokio::test]
    async fn tail_log_journal_unavailable() {
        let (ctx, _rx) = dummy_ctx();
        let v = method_tail_log(&ctx, &json!({"lines": 10})).await.unwrap();
        assert_eq!(v["source"], "journal-unavailable");
        assert_eq!(v["lines"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn tail_log_reads_file() {
        let tmp = tempfile::NamedTempFile::new().expect("tmp");
        std::fs::write(tmp.path(), "line1\nline2\nline3\nline4\n").unwrap();
        let (mut ctx, _rx) = dummy_ctx();
        ctx.log_file_path = Some(tmp.path().to_path_buf());
        let v = method_tail_log(&ctx, &json!({"lines": 2})).await.unwrap();
        assert_eq!(v["source"], "file");
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "line3");
        assert_eq!(lines[1], "line4");
    }

    #[tokio::test]
    async fn dispatch_unknown_method() {
        let (ctx, _rx) = dummy_ctx();
        let mut conn = ConnState { subscribed: false };
        let req = serde_json::from_str::<RpcRequest>(
            r#"{"jsonrpc":"2.0","id":1,"method":"nope"}"#,
        )
        .unwrap();
        let resp = dispatch(&ctx, &mut conn, req).await.unwrap();
        let parsed: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(parsed["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn dispatch_subscribe_flips_state() {
        let (ctx, _rx) = dummy_ctx();
        let mut conn = ConnState { subscribed: false };
        let req = serde_json::from_str::<RpcRequest>(
            r#"{"jsonrpc":"2.0","id":2,"method":"subscribe_events"}"#,
        )
        .unwrap();
        let _ = dispatch(&ctx, &mut conn, req).await.unwrap();
        assert!(conn.subscribed);
    }

    #[tokio::test]
    async fn reload_config_missing_file_errors() {
        let (mut ctx, _rx) = dummy_ctx();
        ctx.config_path = "/nonexistent/vigil.toml".to_string();
        let err = method_reload_config(&ctx).await;
        assert!(err.is_err());
    }
}
