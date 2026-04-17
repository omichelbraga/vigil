//! Smoke integration test for the IPC server.
//!
//! Spawns a real `ipc::serve` on a tempdir-local Unix socket with a mocked
//! `IpcContext` (all Arcs stubbed to sensible defaults), opens a client
//! connection, sends a `get_status` JSON-RPC request, and asserts the
//! response shape.
//!
//! Unix-only — Windows named pipes have platform-specific quirks that make
//! them awkward to test with a random-path socket; that path is covered by
//! manual smoke runs in CI.

#![cfg(unix)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_util::codec::{Framed, LinesCodec};

use vigil_agent::buffer::EventBuffer;
use vigil_agent::ipc::{self, AgentEvent, IpcContext};

// Tests in this file set the process-wide VIGIL_IPC_PATH env var — run them
// serially so they don't race each other.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn mk_ctx(events_tx: broadcast::Sender<AgentEvent>) -> IpcContext {
    let (runnow_tx, _rx) = mpsc::channel(8);
    let buffer = Arc::new(Mutex::new(
        EventBuffer::new(":memory:").expect("in-mem buffer"),
    ));
    let (reload_tx, _reload_rx) = tokio::sync::watch::channel(0u64);
    IpcContext {
        hub_url: "wss://hub.example/ws".to_string(),
        agent_name: "smoke-agent".to_string(),
        agent_id: Arc::new(Mutex::new(Some("agent-xyz".to_string()))),
        signing_pubkey_hex: "aabbccddeeff0011".to_string(),
        connected: Arc::new(AtomicBool::new(true)),
        silence: Arc::new(Mutex::new(HashMap::new())),
        runnow_tx,
        buffer,
        dropped_events: Arc::new(AtomicU64::new(0)),
        start: Instant::now(),
        config_path: "config.toml".into(),
        paused_until: ipc::new_paused_until(),
        events_tx,
        check_rows: ipc::new_check_rows(),
        reload_tx,
        log_file_path: None,
    }
}

#[tokio::test]
async fn ipc_get_status_round_trip() {
    let _g = ENV_LOCK.lock().unwrap();
    // Use a temp socket so we don't clash with a real running agent.
    let dir = tempfile::tempdir().expect("tempdir");
    let sock = dir.path().join("vigil-test.sock");
    // SAFETY: set_var is unsafe in Rust 2024; still fine for a single-threaded
    // test runner in the 2021 edition this crate uses.
    std::env::set_var("VIGIL_IPC_PATH", &sock);

    let (events_tx, _events_rx) = broadcast::channel(16);
    let ctx = mk_ctx(events_tx);

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };
        ipc::serve(ctx, shutdown).await.expect("ipc serve");
    });

    // Wait for the socket to appear.
    let deadline = Instant::now() + Duration::from_secs(3);
    while !sock.exists() {
        if Instant::now() > deadline {
            panic!("ipc socket didn't appear in time");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Open a client, send get_status, assert the response shape.
    let stream = UnixStream::connect(&sock).await.expect("connect client");
    let mut framed = Framed::new(stream, LinesCodec::new_with_max_length(64 * 1024));
    let req = json!({"jsonrpc":"2.0","id":1,"method":"get_status","params":{}});
    framed
        .send(req.to_string())
        .await
        .expect("send get_status");

    let resp_line = framed
        .next()
        .await
        .expect("got something")
        .expect("decode ok");
    let resp: serde_json::Value = serde_json::from_str(&resp_line).expect("json parse");

    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 1);
    let res = &resp["result"];
    assert_eq!(res["agent_name"], "smoke-agent");
    assert_eq!(res["hub_url"], "wss://hub.example/ws");
    assert_eq!(res["connected"], true);
    assert!(res["version"].is_string());
    assert!(res["uptime_secs"].is_number());
    assert_eq!(res["signing_pubkey_prefix"], "aabbccdd");

    // Now exercise a second method on the same framed stream (connections
    // are long-lived — smoke-check we can do multiple calls).
    let req2 = json!({"jsonrpc":"2.0","id":2,"method":"list_checks","params":{}});
    framed
        .send(req2.to_string())
        .await
        .expect("send list_checks");
    let resp_line2 = framed.next().await.expect("ok").expect("decode");
    let resp2: serde_json::Value = serde_json::from_str(&resp_line2).unwrap();
    assert_eq!(resp2["id"], 2);
    assert!(resp2["result"].is_array());

    // Test that parse errors come back with -32700 and don't kill the listener.
    framed
        .send("{not valid json".to_string())
        .await
        .expect("send garbage");
    let resp_line3 = framed.next().await.expect("ok").expect("decode");
    let resp3: serde_json::Value = serde_json::from_str(&resp_line3).unwrap();
    assert_eq!(resp3["error"]["code"], -32700);

    // Tear down.
    drop(framed);
    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
}

#[tokio::test]
async fn ipc_unknown_method_returns_32601() {
    let _g = ENV_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let sock = dir.path().join("vigil-unknown.sock");
    std::env::set_var("VIGIL_IPC_PATH", &sock);

    let (events_tx, _rx) = broadcast::channel(16);
    let ctx = mk_ctx(events_tx);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };
        ipc::serve(ctx, shutdown).await.unwrap();
    });

    let deadline = Instant::now() + Duration::from_secs(3);
    while !sock.exists() {
        if Instant::now() > deadline {
            panic!("socket missing");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let stream = UnixStream::connect(&sock).await.unwrap();
    let mut framed = Framed::new(stream, LinesCodec::new_with_max_length(64 * 1024));
    framed
        .send(r#"{"jsonrpc":"2.0","id":9,"method":"nonesuch","params":{}}"#.to_string())
        .await
        .unwrap();
    let line = framed.next().await.unwrap().unwrap();
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["error"]["code"], -32601);

    drop(framed);
    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
}
