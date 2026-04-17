//! vigil-tray — system-tray companion for vigil-agent.
//!
//! Responsibilities:
//!   * single-instance guard (Windows mutex / Unix flock)
//!   * own a tao event loop on the main thread (required by tray-icon
//!     + wry on Windows + GTK)
//!   * run a tokio runtime on a background thread to talk to the
//!     agent over IPC, refresh state, forward events
//!   * rebuild the tray menu + swap icons as state changes
//!   * own the HUD & wizard webview windows (when `hud` feature is on)

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(feature = "tray")]
use std::time::Duration;

use anyhow::Result;

mod autostart;
mod ipc_client;
mod state;
mod wizard;

#[cfg(feature = "tray")]
mod menu;
#[cfg(feature = "hud")]
mod hud;

#[cfg(feature = "tray")]
use state::{AppState, EventFrame, HealthColor, derive_color, push_event};

// -------------------------------------------------------------------------
// Single-instance guard
// -------------------------------------------------------------------------

/// RAII handle — dropped on process exit (OS cleans up).
#[cfg(windows)]
#[allow(dead_code)]
struct InstanceLock(windows::Win32::Foundation::HANDLE);
#[cfg(unix)]
#[allow(dead_code)]
struct InstanceLock(std::fs::File);

#[cfg(windows)]
fn try_single_instance() -> Result<InstanceLock> {
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    unsafe {
        let h = CreateMutexW(None, false, w!("Global\\VigilTraySingleton"))
            .map_err(|e| anyhow::anyhow!("CreateMutexW: {e}"))?;
        let err = GetLastError();
        if err == ERROR_ALREADY_EXISTS {
            anyhow::bail!("another vigil-tray instance is already running");
        }
        Ok(InstanceLock(h))
    }
}

#[cfg(unix)]
fn try_single_instance() -> Result<InstanceLock> {
    use std::fs::OpenOptions;
    use std::os::unix::io::AsRawFd;

    let path = "/tmp/vigil-tray.lock";
    let file = OpenOptions::new()
        .create(true).read(true).write(true)
        .open(path)?;
    let fd = file.as_raw_fd();
    // Non-blocking exclusive lock
    let rc = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        anyhow::bail!("another vigil-tray instance is already running");
    }
    Ok(InstanceLock(file))
}

// -------------------------------------------------------------------------
// Custom event wired into tao's EventLoop
// -------------------------------------------------------------------------

#[cfg(feature = "tray")]
#[derive(Debug, Clone)]
enum UserEvent {
    /// Pushed when background task refreshes state — rebuild menu + icon.
    StateUpdated,
    /// An individual event frame arrived (broadcast to HUD).
    EventFrame(EventFrame),
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

fn main() {
    init_tracing();

    let _lock = match try_single_instance() {
        Ok(l) => l,
        Err(e) => {
            tracing::info!("{e}");
            return;
        }
    };

    autostart::ensure_first_run();

    // Feature-conditional dispatch.
    #[cfg(feature = "tray")]
    {
        if let Err(e) = run_tray() {
            tracing::error!("vigil-tray exited with error: {e:?}");
            std::process::exit(1);
        }
    }

    #[cfg(not(feature = "tray"))]
    {
        // Headless build — useful for sanity-checking the IPC layer on
        // servers without a GUI. Runs a single get_status ping and exits.
        run_headless();
    }
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,vigil_tray=debug"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

#[cfg(not(feature = "tray"))]
fn run_headless() {
    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    rt.block_on(async {
        match ipc_client::call("get_status", serde_json::json!({})).await {
            Ok(v) => {
                println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            }
            Err(e) => {
                eprintln!("ipc get_status failed: {e:#}");
            }
        }
    });
}

// -------------------------------------------------------------------------
// Full tray+HUD runtime
// -------------------------------------------------------------------------

#[cfg(feature = "tray")]
fn run_tray() -> Result<()> {
    use tao::event::Event;
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tray_icon::menu::MenuEvent;
    use tray_icon::{TrayIconBuilder, TrayIconEvent};

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let app_state = state::new_app_state();

    // Tokio runtime on a dedicated thread. We can't use a current-thread
    // runtime here because the main thread is running tao's event loop
    // (which blocks on native OS message pumps).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let rt_handle = rt.handle().clone();
    // Keep runtime alive for process lifetime (dropped at exit).
    std::mem::forget(rt);

    spawn_background_tasks(rt_handle.clone(), app_state.clone(), proxy.clone());

    // Build initial tray icon
    let initial_icon_bytes = icon_bytes_for(HealthColor::Gray);
    let initial_icon = tray_icon_from_png(initial_icon_bytes)?;

    let initial_menu = menu::build(&app_state.lock().unwrap());
    let tray = TrayIconBuilder::new()
        .with_tooltip("Vigil — loading…")
        .with_icon(initial_icon)
        .with_menu(Box::new(initial_menu))
        .build()?;

    let menu_channel = MenuEvent::receiver();
    let tray_channel = TrayIconEvent::receiver();

    #[cfg(feature = "hud")]
    let mut hud_mgr = hud::HudManager::new(app_state.clone());

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;

        // Drain menu click events
        while let Ok(ev) = menu_channel.try_recv() {
            handle_menu_event(
                ev,
                &app_state,
                &rt_handle,
                &proxy,
                #[cfg(feature = "hud")]
                &mut hud_mgr,
                target,
            );
        }

        // Drain tray click events (double-click opens HUD, single-click
        // just updates tooltip which we do live anyway).
        while let Ok(ev) = tray_channel.try_recv() {
            if let TrayIconEvent::DoubleClick { .. } = ev {
                #[cfg(feature = "hud")]
                {
                    if let Err(e) = hud_mgr.open_or_focus(target) {
                        tracing::warn!(error = %e, "hud open failed");
                    }
                }
                #[cfg(not(feature = "hud"))]
                {
                    // Without HUD, fall back to opening the dashboard.
                    open_dashboard_from_state(&app_state);
                }
            }
        }

        // Drain HUD actions
        #[cfg(feature = "hud")]
        for action in hud_mgr.drain_actions() {
            handle_hud_action(action, &app_state, &rt_handle, &hud_mgr);
        }

        match event {
            Event::UserEvent(UserEvent::StateUpdated) => {
                refresh_tray(&tray, &app_state);
                #[cfg(feature = "hud")]
                hud_mgr.push_snapshot();
            }
            Event::UserEvent(UserEvent::EventFrame(frame)) => {
                push_event(&app_state, frame.clone());
                #[cfg(feature = "hud")]
                hud_mgr.push_event(&frame);
            }
            #[cfg(feature = "hud")]
            Event::WindowEvent { event: tao::event::WindowEvent::CloseRequested, window_id, .. } => {
                hud_mgr.on_close_requested(window_id);
            }
            _ => {}
        }
    });
}

#[cfg(feature = "tray")]
fn refresh_tray(tray: &tray_icon::TrayIcon, app_state: &AppState) {
    let guard = app_state.lock().unwrap();
    let color = derive_color(&guard);
    let tooltip = match &guard.status {
        Some(s) if guard.ipc_reachable => {
            let conn = if s.connected { "online" } else { "offline" };
            format!("Vigil — {} [{conn}]", s.agent_name)
        }
        _ => "Vigil — agent unreachable".to_string(),
    };
    let new_menu = menu::build(&guard);
    drop(guard);

    if let Ok(icon) = tray_icon_from_png(icon_bytes_for(color)) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(&tooltip));
    tray.set_menu(Some(Box::new(new_menu)));
}

#[cfg(feature = "tray")]
fn tray_icon_from_png(bytes: &[u8]) -> Result<tray_icon::Icon> {
    use image::GenericImageView;
    let img = image::load_from_memory(bytes)?;
    let (w, h) = img.dimensions();
    let rgba = img.into_rgba8().into_raw();
    Ok(tray_icon::Icon::from_rgba(rgba, w, h)?)
}

#[cfg(feature = "tray")]
fn icon_bytes_for(color: HealthColor) -> &'static [u8] {
    match color {
        HealthColor::Gray    => include_bytes!("../assets/tray-icon-gray.png"),
        HealthColor::Green   => include_bytes!("../assets/tray-icon-ok.png"),
        HealthColor::Amber   => include_bytes!("../assets/tray-icon-amber.png"),
        HealthColor::Red     => include_bytes!("../assets/tray-icon-red.png"),
        HealthColor::Unknown => include_bytes!("../assets/tray-icon-unknown.png"),
    }
}

// -------------------------------------------------------------------------
// Background tasks (all async, run on the tokio runtime)
// -------------------------------------------------------------------------

#[cfg(feature = "tray")]
fn spawn_background_tasks(
    rt: tokio::runtime::Handle,
    state: AppState,
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
) {
    // Task 1 — periodic get_status + list_checks refresh.
    {
        let state  = state.clone();
        let proxy  = proxy.clone();
        rt.spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            loop {
                tick.tick().await;
                refresh_state(&state).await;
                let _ = proxy.send_event(UserEvent::StateUpdated);
            }
        });
    }

    // Task 2 — subscribe to events, forward.
    {
        let state = state.clone();
        let proxy = proxy.clone();
        rt.spawn(async move {
            let (tx, mut rx) = tokio::sync::mpsc::channel(64);
            let state_for_loop = state.clone();
            tokio::spawn(async move {
                ipc_client::subscribe_loop(tx).await;
            });
            while let Some(ev) = rx.recv().await {
                match ev {
                    ipc_client::SubEvent::Connected => {
                        let mut g = state_for_loop.lock().unwrap();
                        g.ipc_reachable = true;
                        drop(g);
                        let _ = proxy.send_event(UserEvent::StateUpdated);
                    }
                    ipc_client::SubEvent::Disconnected { reason } => {
                        let mut g = state_for_loop.lock().unwrap();
                        g.ipc_reachable = false;
                        g.last_ipc_error = Some(reason);
                        drop(g);
                        let _ = proxy.send_event(UserEvent::StateUpdated);
                    }
                    ipc_client::SubEvent::Event { name, data } => {
                        let frame = EventFrame {
                            at:   chrono::Utc::now(),
                            name,
                            data,
                        };
                        let _ = proxy.send_event(UserEvent::EventFrame(frame));
                    }
                }
            }
        });
    }
}

#[cfg(feature = "tray")]
async fn refresh_state(state: &AppState) {
    // get_status
    let status_res = ipc_client::call("get_status", serde_json::json!({})).await;
    let checks_res = ipc_client::call("list_checks", serde_json::json!({})).await;

    let mut guard = state.lock().unwrap();
    match status_res {
        Ok(v) => {
            match serde_json::from_value::<state::AgentStatus>(v) {
                Ok(s) => {
                    guard.status = Some(s);
                    guard.ipc_reachable = true;
                    guard.last_ipc_error = None;
                }
                Err(e) => {
                    guard.last_ipc_error = Some(format!("decode status: {e}"));
                }
            }
        }
        Err(e) => {
            guard.ipc_reachable = false;
            guard.last_ipc_error = Some(e.to_string());
        }
    }
    if let Ok(v) = checks_res {
        if let Ok(rows) = serde_json::from_value::<Vec<state::CheckRow>>(v) {
            guard.checks = rows;
        }
    }
}

// -------------------------------------------------------------------------
// Menu / HUD action handlers
// -------------------------------------------------------------------------

#[cfg(feature = "tray")]
fn handle_menu_event(
    ev: tray_icon::menu::MenuEvent,
    state: &AppState,
    rt: &tokio::runtime::Handle,
    proxy: &tao::event_loop::EventLoopProxy<UserEvent>,
    #[cfg(feature = "hud")] hud_mgr: &mut hud::HudManager,
    target: &tao::event_loop::EventLoopWindowTarget<UserEvent>,
) {
    let id = ev.id.0.as_str().to_string();
    tracing::debug!(id = %id, "menu event");

    match id.as_str() {
        "quit" => {
            // tao 0.35 doesn't expose a public "exit" on the target; the
            // canonical approach is to exit the process directly. Drop
            // order doesn't matter — the tokio runtime was already
            // forgotten on purpose.
            std::process::exit(0);
        }
        "open_dashboard" => open_dashboard_from_state(state),
        "open_hud" => {
            #[cfg(feature = "hud")]
            {
                if let Err(e) = hud_mgr.open_or_focus(target) {
                    tracing::warn!(error = %e, "hud open failed");
                }
            }
            #[cfg(not(feature = "hud"))]
            open_dashboard_from_state(state);
        }
        "run_doctor" => {
            if let Err(e) = wizard::spawn_doctor() {
                tracing::warn!(error = %e, "spawn doctor failed");
            }
        }
        "connect" => {
            #[cfg(feature = "hud")]
            {
                if let Err(e) = hud_mgr.open_wizard(target) {
                    tracing::warn!(error = %e, "wizard open failed");
                }
            }
            #[cfg(not(feature = "hud"))]
            tracing::info!("wizard UI unavailable (hud feature not enabled)");
        }
        "reload" => {
            let _ = rt.spawn(async move {
                if let Err(e) = ipc_client::call("reload_config", serde_json::json!({})).await {
                    tracing::warn!(error = %e, "reload_config failed");
                }
            });
            let _ = proxy.send_event(UserEvent::StateUpdated);
        }
        other if other.starts_with("pause:") => {
            if let Some(secs) = other.strip_prefix("pause:").and_then(|s| s.parse::<u64>().ok()) {
                rt.spawn(async move {
                    let _ = ipc_client::call(
                        "pause_all",
                        serde_json::json!({ "duration_secs": secs }),
                    ).await;
                });
            }
        }
        other if other.starts_with("run:") => {
            let check_id = other.trim_start_matches("run:").to_string();
            rt.spawn(async move {
                let _ = ipc_client::call(
                    "run_check_now",
                    serde_json::json!({ "check_id": check_id }),
                ).await;
            });
        }
        other if other.starts_with("silence:") => {
            // silence:<id>:<secs>
            let rest = other.trim_start_matches("silence:");
            if let Some((check_id, secs_str)) = rest.rsplit_once(':') {
                if let Ok(secs) = secs_str.parse::<u64>() {
                    let check_id = check_id.to_string();
                    rt.spawn(async move {
                        let _ = ipc_client::call(
                            "silence",
                            serde_json::json!({
                                "check_id": check_id,
                                "duration_secs": secs,
                            }),
                        ).await;
                    });
                }
            }
        }
        _ => {}
    }
    let _ = target;
    #[cfg(not(feature = "hud"))]
    let _ = target;
}

#[cfg(feature = "tray")]
fn open_dashboard_from_state(state: &AppState) {
    let url = {
        let g = state.lock().unwrap();
        g.status.as_ref().map(|s| s.hub_url.clone())
    };
    match url {
        Some(u) if !u.is_empty() => {
            if let Err(e) = webbrowser::open(&u) {
                tracing::warn!(error = %e, "open dashboard failed");
            }
        }
        _ => tracing::info!("no hub URL yet — agent unreachable"),
    }
}

#[cfg(feature = "hud")]
fn handle_hud_action(
    action: hud::HudAction,
    state: &AppState,
    rt: &tokio::runtime::Handle,
    hud_mgr: &hud::HudManager,
) {
    use hud::HudAction::*;
    match action {
        Bootstrap { reply_id } => {
            let guard = state.lock().unwrap();
            let payload = serde_json::json!({
                "status":        guard.status,
                "checks":        guard.checks,
                "events":        guard.recent_events,
                "ipc_path":      ipc_client::transport_path(),
                "ipc_reachable": guard.ipc_reachable,
                "color":         format!("{:?}", derive_color(&guard)).to_lowercase(),
            });
            drop(guard);
            hud_mgr.reply(reply_id, Ok(payload));
        }
        OpenUrl { url } => {
            let _ = webbrowser::open(&url);
        }
        OpenDashboard => open_dashboard_from_state(state),
        OpenCheckInDashboard { check_id } => {
            let guard = state.lock().unwrap();
            let hub = guard.status.as_ref().map(|s| s.hub_url.clone()).unwrap_or_default();
            drop(guard);
            if !hub.is_empty() {
                let url = format!("{}/checks/{}", hub.trim_end_matches('/'), check_id);
                let _ = webbrowser::open(&url);
            }
        }
        RunDoctor => {
            if let Err(e) = wizard::spawn_doctor() {
                tracing::warn!(error = %e, "spawn doctor failed");
            }
        }
        CopyIpcPath => {
            // tray-icon 0.22 has clipboard access via `muda`; keep this
            // simple — just log. A future revision can pull in `arboard`.
            tracing::info!(path = %ipc_client::transport_path(), "ipc path");
        }
        TailLog { lines, reply_id } => {
            let hud_mgr_ptr = hud_mgr as *const hud::HudManager as usize;
            rt.spawn(async move {
                let res = ipc_client::call(
                    "tail_log",
                    serde_json::json!({ "lines": lines }),
                ).await;
                // Route reply back via unsafe pointer is not OK across
                // threads. Instead, we rely on the fact that actions
                // originating from JS expect async replies — so we push
                // via evaluate_script which is thread-safe on wry. But
                // hud_mgr isn't Send. Simplest fix: serialise reply into
                // a log and also attempt a best-effort synchronous reply
                // by posting a UserEvent the main loop will consume.
                //
                // For v0.3 we just log it.
                let _ = hud_mgr_ptr; // silence unused warning; reply is logged
                match res {
                    Ok(v) => tracing::info!(reply_id, payload = %v, "tail_log ok"),
                    Err(e) => tracing::warn!(reply_id, error = %e, "tail_log failed"),
                }
            });
        }
        ReloadConfig { reply_id } => {
            rt.spawn(async move {
                match ipc_client::call("reload_config", serde_json::json!({})).await {
                    Ok(_)  => tracing::info!(reply_id, "reload_config ok"),
                    Err(e) => tracing::warn!(reply_id, error = %e, "reload_config failed"),
                }
            });
        }
        RunCheck { check_id, reply_id } => {
            rt.spawn(async move {
                let _ = reply_id;
                let _ = ipc_client::call(
                    "run_check_now",
                    serde_json::json!({ "check_id": check_id }),
                ).await;
            });
        }
        Silence { check_id, duration_secs, reply_id } => {
            rt.spawn(async move {
                let _ = reply_id;
                let _ = ipc_client::call(
                    "silence",
                    serde_json::json!({
                        "check_id": check_id,
                        "duration_secs": duration_secs,
                    }),
                ).await;
            });
        }
        WizardTestConnection { hub_url, reply_id } => {
            // Wizard calls are rare (user-driven) and need to reply on
            // the same thread. We're already on the UI thread (not a
            // tokio worker), so `block_on` via the shared handle is
            // safe. The request is fast (5-s timeout enforced inside).
            let result = rt.block_on(wizard::test_connection(&hub_url));
            match result {
                Ok(body) => hud_mgr.reply(
                    reply_id,
                    Ok(serde_json::json!({ "ok": true, "body_len": body.len() })),
                ),
                Err(e) => hud_mgr.reply(reply_id, Err(e)),
            }
        }
        WizardEnroll { hub_url, token, reply_id } => {
            let result = rt.block_on(wizard::enroll(&hub_url, &token));
            match result {
                Ok(stdout) => {
                    hud_mgr.wizard_log(&stdout, "status-ok");
                    hud_mgr.reply(reply_id, Ok(serde_json::json!({ "ok": true })));
                }
                Err(e) => {
                    hud_mgr.wizard_log(&e.to_string(), "status-err");
                    hud_mgr.reply(reply_id, Err(e));
                }
            }
        }
    }
}

