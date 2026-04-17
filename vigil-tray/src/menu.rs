//! Tray menu construction + re-render.
//!
//! The menu is rebuilt from scratch every time we receive fresh data
//! (status updates, new check list) because `tray-icon`'s `Menu` type
//! treats items as immutable — trying to mutate labels in place across
//! platform backends is fragile. Rebuilding gives a consistent result
//! on GTK (`ksni`), Windows Shell_NotifyIcon, and macOS.
//!
//! Menu ID convention — prefix:arg   (parsed by `main::handle_menu_event`)
//!   quit
//!   open_hud
//!   open_dashboard
//!   run_doctor
//!   connect
//!   reload
//!   pause:3600          seconds
//!   pause:14400
//!   run:<check_id>
//!   silence:<check_id>:900     seconds
//!   silence:<check_id>:3600
//!   silence:<check_id>:14400

#![cfg(feature = "tray")]

use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

use crate::state::{AppStateInner, CheckRow};

/// Build the full right-click menu from a state snapshot.
pub fn build(state: &AppStateInner) -> Menu {
    let menu = Menu::new();

    // -- status header (disabled / informational) --------------------------
    let header_label = match &state.status {
        Some(s) if state.ipc_reachable => {
            let conn = if s.connected { "online" } else { "offline" };
            let pause = match &s.paused_until {
                Some(_) => " [paused]",
                None => "",
            };
            format!("{} — {} • v{}{}", s.agent_name, conn, s.version, pause)
        }
        _ => "Agent unreachable".to_string(),
    };
    let header = MenuItem::new(header_label, false, None);
    let _ = menu.append(&header);

    let _ = menu.append(&PredefinedMenuItem::separator());

    // -- top actions -------------------------------------------------------
    let dashboard = MenuItem::with_id(
        "open_dashboard",
        "Open Dashboard",
        state.status.is_some(),
        None,
    );
    let _ = menu.append(&dashboard);

    let hud = MenuItem::with_id("open_hud", "Show HUD…", true, None);
    let _ = menu.append(&hud);

    let _ = menu.append(&PredefinedMenuItem::separator());

    // -- doctor ------------------------------------------------------------
    let doctor = MenuItem::with_id("run_doctor", "Run Doctor", true, None);
    let _ = menu.append(&doctor);

    // -- Run check ▸ -------------------------------------------------------
    let run_menu = Submenu::new("Run check", !state.checks.is_empty());
    for row in &state.checks {
        let id = format!("run:{}", row.id);
        let item = MenuItem::with_id(id, label_for_check(row), true, None);
        let _ = run_menu.append(&item);
    }
    if state.checks.is_empty() {
        let placeholder = MenuItem::new("(no checks available)", false, None);
        let _ = run_menu.append(&placeholder);
    }
    let _ = menu.append(&run_menu);

    // -- Silence check ▸ ---------------------------------------------------
    let silence_menu = Submenu::new("Silence check", !state.checks.is_empty());
    for row in &state.checks {
        let sub = Submenu::new(label_for_check(row), true);
        for (label, secs) in [("15 min", 15 * 60), ("1 hour", 3600), ("4 hours", 14_400)] {
            let id = format!("silence:{}:{}", row.id, secs);
            let item = MenuItem::with_id(id, label, true, None);
            let _ = sub.append(&item);
        }
        let _ = silence_menu.append(&sub);
    }
    if state.checks.is_empty() {
        let placeholder = MenuItem::new("(no checks available)", false, None);
        let _ = silence_menu.append(&placeholder);
    }
    let _ = menu.append(&silence_menu);

    // -- Pause monitoring ▸ ------------------------------------------------
    let pause_menu = Submenu::new("Pause monitoring for", state.ipc_reachable);
    for (label, secs) in [("1 hour", 3600u64), ("4 hours", 14_400)] {
        let item = MenuItem::with_id(format!("pause:{secs}"), label, true, None);
        let _ = pause_menu.append(&item);
    }
    let _ = menu.append(&pause_menu);

    let _ = menu.append(&PredefinedMenuItem::separator());

    // -- Connect / reload --------------------------------------------------
    let connect = MenuItem::with_id("connect", "Connect to Hub…", true, None);
    let _ = menu.append(&connect);
    let reload = MenuItem::with_id(
        "reload",
        "Reload agent config",
        state.ipc_reachable,
        None,
    );
    let _ = menu.append(&reload);

    let _ = menu.append(&PredefinedMenuItem::separator());

    // -- Quit --------------------------------------------------------------
    let quit = MenuItem::with_id("quit", "Quit Tray", true, None);
    let _ = menu.append(&quit);

    menu
}

fn label_for_check(row: &CheckRow) -> String {
    let status = row.status_last.as_deref().unwrap_or("?");
    let latency = match row.latency_last_ms {
        Some(ms) => format!(" • {ms} ms"),
        None => String::new(),
    };
    format!("{} [{}]{}", row.name, status, latency)
}
