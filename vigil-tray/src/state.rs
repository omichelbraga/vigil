//! App-wide shared mutable state.
//!
//! The tray process is a small pub/sub system: an async task talks to the
//! agent over IPC and republishes snapshots here. The event loop (on the
//! main thread) reads this state synchronously when it needs to re-render
//! the menu, and the HUD webview reads it via IPC bridge messages.
//!
//! We intentionally use `parking_lot`-free `std::sync::Mutex` — the
//! critical sections are tiny (one struct clone) and we want to be usable
//! from both blocking and async callers without spawning blocking tasks.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Result of a successful `get_status` call. Mirrors the IPC schema from
/// `vigil-agent/src/ipc.rs::method_get_status`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AgentStatus {
    pub connected: bool,
    pub hub_url: String,
    pub agent_name: String,
    pub agent_id: Option<String>,
    pub version: String,
    pub protocol_version: Option<u32>,
    pub ipc_protocol_version: Option<u32>,
    pub signing_pubkey_prefix: Option<String>,
    pub buffer_depth: u64,
    pub dropped_events: u64,
    pub uptime_secs: u64,
    pub check_count: u64,
    pub paused_until: Option<DateTime<Utc>>,
}

/// One row from `list_checks`. Mirrors `ipc::CheckRow`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CheckRow {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub check_type: String,
    pub target: String,
    pub source: String,
    pub status_last: Option<String>,
    pub latency_last_ms: Option<u64>,
    pub last_checked: Option<DateTime<Utc>>,
    pub silenced_until: Option<DateTime<Utc>>,
}

/// Derived traffic-light colour for the tray icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthColor {
    Gray,    // IPC unreachable — no agent
    Green,   // connected + all checks OK
    Amber,   // any warning
    Red,     // any critical or disconnected
    Unknown, // connected but no results yet
}

/// One event frame we've received from `subscribe_events`. Kept as raw
/// JSON so we can re-serialise into the HUD without re-declaring every
/// event variant.
#[derive(Clone, Debug, Serialize)]
pub struct EventFrame {
    pub at:   DateTime<Utc>,
    pub name: String,
    pub data: serde_json::Value,
}

#[derive(Default)]
pub struct AppStateInner {
    pub status:         Option<AgentStatus>,
    pub checks:         Vec<CheckRow>,
    pub ipc_reachable:  bool,
    pub recent_events:  Vec<EventFrame>, // ring buffer, newest-first, cap 50
    pub last_ipc_error: Option<String>,
}

pub type AppState = Arc<Mutex<AppStateInner>>;

pub fn new_app_state() -> AppState {
    Arc::new(Mutex::new(AppStateInner::default()))
}

/// Derive the current health colour from a state snapshot.
///
/// Precedence (most severe wins):
/// * no IPC => Gray
/// * not connected to hub => Red
/// * any check with `status_last == "critical"` => Red
/// * any check with `status_last == "warning"` => Amber
/// * any check with a concrete `ok` status => Green
/// * else Unknown (connected but no check results yet)
pub fn derive_color(state: &AppStateInner) -> HealthColor {
    if !state.ipc_reachable {
        return HealthColor::Gray;
    }
    let status = match &state.status {
        Some(s) => s,
        None => return HealthColor::Gray,
    };
    if !status.connected {
        return HealthColor::Red;
    }
    let mut has_ok      = false;
    let mut has_warning = false;
    for row in &state.checks {
        match row.status_last.as_deref() {
            Some("critical") | Some("down") | Some("error") => return HealthColor::Red,
            Some("warning") | Some("warn") | Some("degraded") => has_warning = true,
            Some("ok") | Some("up") | Some("healthy") => has_ok = true,
            _ => {}
        }
    }
    if has_warning {
        HealthColor::Amber
    } else if has_ok {
        HealthColor::Green
    } else {
        HealthColor::Unknown
    }
}

/// Push an event frame, keeping the last 50 newest-first.
pub fn push_event(state: &AppState, frame: EventFrame) {
    let mut guard = state.lock().expect("app state mutex");
    guard.recent_events.insert(0, frame);
    if guard.recent_events.len() > 50 {
        guard.recent_events.truncate(50);
    }
}
