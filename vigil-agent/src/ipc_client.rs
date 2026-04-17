//! IPC client used by the `ctl` subcommand of the vigil-agent binary.
//!
//! Opens the same transport the server binds to (unix socket on Linux,
//! named pipe on Windows), exchanges newline-delimited JSON-RPC, and
//! returns the parsed `result` payload.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_util::codec::{Framed, LinesCodec};

#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;

/// One round-trip: serialise `params`, send, parse the first non-event
/// response from the stream, return it.
pub async fn call(method: &str, params: Value) -> Result<Value> {
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    #[cfg(unix)]
    {
        let path = unix_path();
        let stream = UnixStream::connect(&path)
            .await
            .with_context(|| format!("connect ipc socket {path}"))?;
        do_call(stream, req).await
    }

    #[cfg(windows)]
    {
        let pipe_name = windows_pipe();
        let stream = ClientOptions::new()
            .open(&pipe_name)
            .with_context(|| format!("open named pipe {pipe_name}"))?;
        do_call(stream, req).await
    }
}

/// Open the transport and return a `Framed` stream callers can drive
/// directly (used by `watch` / `tail --follow`).
pub async fn subscribe_stream() -> Result<FramedStream> {
    #[cfg(unix)]
    {
        let path = unix_path();
        let stream = UnixStream::connect(&path)
            .await
            .with_context(|| format!("connect ipc socket {path}"))?;
        let framed = Framed::new(stream, LinesCodec::new_with_max_length(super::ipc::MAX_FRAME_BYTES));
        Ok(FramedStream::Unix(framed))
    }
    #[cfg(windows)]
    {
        let pipe_name = windows_pipe();
        let stream = ClientOptions::new()
            .open(&pipe_name)
            .with_context(|| format!("open named pipe {pipe_name}"))?;
        let framed = Framed::new(stream, LinesCodec::new_with_max_length(super::ipc::MAX_FRAME_BYTES));
        Ok(FramedStream::Windows(framed))
    }
}

/// Enum wrapper so call-sites can hold a subscribed stream without
/// plumbing platform-specific generics everywhere.
pub enum FramedStream {
    #[cfg(unix)]
    Unix(Framed<UnixStream, LinesCodec>),
    #[cfg(windows)]
    Windows(Framed<tokio::net::windows::named_pipe::NamedPipeClient, LinesCodec>),
}

impl FramedStream {
    pub async fn send(&mut self, line: String) -> Result<()> {
        match self {
            #[cfg(unix)]
            FramedStream::Unix(f) => {
                f.send(line).await?;
            }
            #[cfg(windows)]
            FramedStream::Windows(f) => {
                f.send(line).await?;
            }
        }
        Ok(())
    }

    pub async fn next_line(&mut self) -> Option<Result<String>> {
        match self {
            #[cfg(unix)]
            FramedStream::Unix(f) => f.next().await.map(|r| r.map_err(anyhow::Error::from)),
            #[cfg(windows)]
            FramedStream::Windows(f) => f.next().await.map(|r| r.map_err(anyhow::Error::from)),
        }
    }
}

async fn do_call<S>(stream: S, req: Value) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    let mut framed = Framed::new(stream, LinesCodec::new_with_max_length(super::ipc::MAX_FRAME_BYTES));
    framed.send(req.to_string()).await?;
    // Skip any event pushes that might arrive before the response (shouldn't
    // normally happen since we didn't subscribe on this call, but be safe).
    while let Some(line) = framed.next().await {
        let line = line.context("read ipc response")?;
        let parsed: Value = serde_json::from_str(&line).context("parse ipc response JSON")?;
        if parsed.get("method").and_then(|v| v.as_str()) == Some("event") {
            continue;
        }
        if let Some(err) = parsed.get("error") {
            let msg = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("ipc error");
            anyhow::bail!("{}", msg);
        }
        return Ok(parsed
            .get("result")
            .cloned()
            .unwrap_or(Value::Null));
    }
    anyhow::bail!("ipc: connection closed before response")
}

#[cfg(unix)]
fn unix_path() -> String {
    if let Ok(p) = std::env::var("VIGIL_IPC_PATH") {
        if !p.is_empty() {
            return p;
        }
    }
    // Prefer the primary location; fall back to /tmp if the primary doesn't exist.
    if std::path::Path::new(super::ipc::DEFAULT_UNIX_SOCK).exists() {
        super::ipc::DEFAULT_UNIX_SOCK.to_string()
    } else {
        super::ipc::FALLBACK_UNIX_SOCK.to_string()
    }
}

#[cfg(windows)]
fn windows_pipe() -> String {
    std::env::var("VIGIL_IPC_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| super::ipc::DEFAULT_WINDOWS_PIPE.to_string())
}
