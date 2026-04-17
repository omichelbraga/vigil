//! Webview-backed HUD window + first-run wizard.
//!
//! Both windows live on the main thread alongside the tray (they must,
//! because tao/wry require UI calls from the thread that owns the event
//! loop on Windows + GTK). We expose a small `HudManager` that the event
//! loop interacts with:
//!
//!   * [`HudManager::open_or_focus`] — show HUD (create if absent, else focus)
//!   * [`HudManager::push_snapshot`]  — push a state snapshot into the SPA
//!   * [`HudManager::push_event`]     — push one event frame
//!   * [`HudManager::open_wizard`]    — show the enroll wizard
//!   * [`HudManager::handle_tao_event`] — forward window events so we
//!     know when to hide vs close.
//!
//! JS <-> Rust bridge — JS posts messages via `window.ipc.postMessage`
//! and the host replies by calling `webview.evaluate_script`:
//!
//!   JS → Rust: {"id":int,"method":str,"params":obj}
//!   Rust → JS (result): window.hudResult(id, payload)
//!   Rust → JS (error) : window.hudError(id, msg)
//!   Rust → JS (push)  : window.hudSnapshot(state) | window.hudEvent(e)
//!
//! The close button hides the window — the tray is the canonical
//! quit affordance.

#![cfg(feature = "hud")]

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder, WindowId};
use tao::dpi::LogicalSize;
use tracing::{debug, error, warn};
use wry::{WebView, WebViewBuilder};

use crate::ipc_client;
use crate::state::{derive_color, AppState, EventFrame};

const HUD_HTML:    &str = include_str!("../assets/hud/index.html");
const WIZARD_HTML: &str = include_str!("../assets/hud/wizard.html");

/// An active webview window.
struct WebViewWindow {
    window:  Window,
    webview: WebView,
}

pub struct HudManager {
    state:  AppState,
    hud:    Option<WebViewWindow>,
    wizard: Option<WebViewWindow>,
    /// Sender channel for actions the JS bridge wants the main loop to run.
    /// The main loop polls this drain between event_loop iterations.
    action_tx: std::sync::mpsc::Sender<HudAction>,
    action_rx: std::sync::mpsc::Receiver<HudAction>,
}

/// Actions that JS can trigger. Handed off to the main loop so the
/// event loop doesn't need to know anything about wry.
#[derive(Debug, Clone)]
pub enum HudAction {
    Bootstrap { reply_id: u64 },
    OpenUrl { url: String },
    OpenDashboard,
    OpenCheckInDashboard { check_id: String },
    RunDoctor,
    CopyIpcPath,
    TailLog { lines: u64, reply_id: u64 },
    ReloadConfig { reply_id: u64 },
    RunCheck { check_id: String, reply_id: u64 },
    Silence { check_id: String, duration_secs: u64, reply_id: u64 },
    WizardTestConnection { hub_url: String, reply_id: u64 },
    WizardEnroll { hub_url: String, token: String, reply_id: u64 },
}

impl HudManager {
    pub fn new(state: AppState) -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        Self {
            state,
            hud: None,
            wizard: None,
            action_tx: tx,
            action_rx: rx,
        }
    }

    pub fn drain_actions(&self) -> Vec<HudAction> {
        self.action_rx.try_iter().collect()
    }

    pub fn action_sender(&self) -> std::sync::mpsc::Sender<HudAction> {
        self.action_tx.clone()
    }

    pub fn has_open_window(&self) -> bool {
        self.hud.is_some() || self.wizard.is_some()
    }

    /// Returns the WindowId if the given id belongs to a managed window.
    pub fn contains(&self, id: WindowId) -> Option<&'static str> {
        if self.hud.as_ref().map(|w| w.window.id()) == Some(id) { return Some("hud"); }
        if self.wizard.as_ref().map(|w| w.window.id()) == Some(id) { return Some("wizard"); }
        None
    }

    /// Called by the main loop on CloseRequested for our windows: hide
    /// instead of dropping.
    pub fn on_close_requested(&mut self, id: WindowId) {
        if let Some(kind) = self.contains(id) {
            match kind {
                "hud" => {
                    if let Some(w) = &self.hud { w.window.set_visible(false); }
                }
                "wizard" => {
                    self.wizard = None; // wizard is one-shot — drop it
                }
                _ => {}
            }
        }
    }

    /// Show the HUD, creating it if necessary.
    pub fn open_or_focus<T: 'static>(
        &mut self,
        target: &EventLoopWindowTarget<T>,
    ) -> Result<()> {
        if let Some(w) = &self.hud {
            w.window.set_visible(true);
            w.window.set_focus();
            return Ok(());
        }
        let window = WindowBuilder::new()
            .with_title("Vigil HUD")
            .with_inner_size(LogicalSize::new(600.0, 460.0))
            .with_min_inner_size(LogicalSize::new(480.0, 320.0))
            .with_resizable(true)
            .build(target)
            .context("create HUD window")?;

        let tx = self.action_tx.clone();
        let webview = build_webview(&window, HUD_HTML, tx)?;
        self.hud = Some(WebViewWindow { window, webview });

        // Send an initial snapshot as soon as the SPA boots — the SPA
        // also calls `bootstrap` which will fetch again, but this makes
        // the UI feel instant.
        self.push_snapshot();
        Ok(())
    }

    /// Show the wizard.
    pub fn open_wizard<T: 'static>(
        &mut self,
        target: &EventLoopWindowTarget<T>,
    ) -> Result<()> {
        if let Some(w) = &self.wizard {
            w.window.set_visible(true);
            w.window.set_focus();
            return Ok(());
        }
        let window = WindowBuilder::new()
            .with_title("Connect to Vigil Hub")
            .with_inner_size(LogicalSize::new(480.0, 360.0))
            .with_resizable(false)
            .build(target)
            .context("create wizard window")?;

        let tx = self.action_tx.clone();
        let webview = build_webview(&window, WIZARD_HTML, tx)?;
        self.wizard = Some(WebViewWindow { window, webview });
        Ok(())
    }

    /// Push a fresh snapshot to the HUD (no-op if hidden).
    pub fn push_snapshot(&self) {
        let Some(w) = &self.hud else { return };
        let guard = self.state.lock().expect("app state");
        let payload = json!({
            "status":     guard.status,
            "checks":     guard.checks,
            "events":     guard.recent_events,
            "ipc_path":   ipc_client::transport_path(),
            "ipc_reachable": guard.ipc_reachable,
            "color":      format!("{:?}", derive_color(&guard)).to_lowercase(),
        });
        drop(guard);
        let js = format!(
            "if (window.hudSnapshot) window.hudSnapshot({});",
            payload
        );
        if let Err(e) = w.webview.evaluate_script(&js) {
            warn!(error = %e, "hud: evaluate_script failed");
        }
    }

    /// Push a single event frame to the HUD.
    pub fn push_event(&self, frame: &EventFrame) {
        let Some(w) = &self.hud else { return };
        let payload = serde_json::to_string(frame).unwrap_or_else(|_| "{}".into());
        let js = format!("if (window.hudEvent) window.hudEvent({});", payload);
        let _ = w.webview.evaluate_script(&js);
    }

    /// Reply to a JS rpc call (on the HUD window).
    pub fn reply(&self, id: u64, payload: Result<Value>) {
        let target = self.hud.as_ref().or(self.wizard.as_ref());
        let Some(w) = target else { return };
        let js = match payload {
            Ok(v)  => format!("window.hudResult({}, {});", id, v),
            Err(e) => {
                let msg = serde_json::to_string(&e.to_string()).unwrap_or_else(|_| "\"\"".into());
                format!("window.hudError({}, {});", id, msg)
            }
        };
        let _ = w.webview.evaluate_script(&js);
    }

    /// Write text into the wizard's log pane.
    pub fn wizard_log(&self, line: &str, cls: &str) {
        let Some(w) = &self.wizard else { return };
        let msg = serde_json::to_string(line).unwrap_or_else(|_| "\"\"".into());
        let cls = serde_json::to_string(cls).unwrap_or_else(|_| "\"\"".into());
        let js = format!("if (window.wizardLog) window.wizardLog({}, {});", msg, cls);
        let _ = w.webview.evaluate_script(&js);
    }

    /// Write text into the diagnostics output pane on the HUD.
    pub fn diag_output(&self, text: &str) {
        let Some(w) = &self.hud else { return };
        let msg = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
        let js = format!("if (window.hudDiagOutput) window.hudDiagOutput({});", msg);
        let _ = w.webview.evaluate_script(&js);
    }
}

/// Wire up the webview: serve the bundled SPA via a custom protocol, and
/// relay JS messages into the shared channel.
fn build_webview(
    window: &Window,
    html: &'static str,
    action_tx: std::sync::mpsc::Sender<HudAction>,
) -> Result<WebView> {
    // We don't use a custom-protocol here — inline the HTML via
    // `with_html` so the binary is self-contained and CSP is a no-op.
    let builder = WebViewBuilder::new()
        .with_html(html)
        .with_ipc_handler(move |req| {
            let body = req.body().to_string();
            if let Err(e) = dispatch_js_message(&body, &action_tx) {
                warn!(error = %e, raw = %body, "hud: ipc dispatch failed");
            }
        });

    let webview = builder.build(window).context("build webview")?;
    Ok(webview)
}

fn dispatch_js_message(
    raw: &str,
    tx: &std::sync::mpsc::Sender<HudAction>,
) -> Result<()> {
    let msg: Value = serde_json::from_str(raw).context("parse js message")?;
    let id     = msg.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    let action = match method {
        "bootstrap" | "get_status" | "list_checks" => HudAction::Bootstrap { reply_id: id },
        "open_url" => HudAction::OpenUrl {
            url: params.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        },
        "open_dashboard" => HudAction::OpenDashboard,
        "open_check_in_dashboard" => HudAction::OpenCheckInDashboard {
            check_id: params.get("check_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        },
        "run_doctor"     => HudAction::RunDoctor,
        "copy_ipc_path"  => HudAction::CopyIpcPath,
        "reload_config"  => HudAction::ReloadConfig { reply_id: id },
        "tail_log" => HudAction::TailLog {
            lines: params.get("lines").and_then(|v| v.as_u64()).unwrap_or(50),
            reply_id: id,
        },
        "run_check_now" => HudAction::RunCheck {
            check_id: params.get("check_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            reply_id: id,
        },
        "silence" => HudAction::Silence {
            check_id: params.get("check_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            duration_secs: params.get("duration_secs").and_then(|v| v.as_u64()).unwrap_or(3600),
            reply_id: id,
        },
        "wizard_test_connection" => HudAction::WizardTestConnection {
            hub_url: params.get("hub_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            reply_id: id,
        },
        "wizard_enroll" => HudAction::WizardEnroll {
            hub_url: params.get("hub_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            token:   params.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            reply_id: id,
        },
        other => {
            debug!(method = %other, "hud: unknown method, ignoring");
            return Ok(());
        }
    };

    if let Err(e) = tx.send(action) {
        error!(error = %e, "hud: forwarding action failed");
    }
    Ok(())
}
