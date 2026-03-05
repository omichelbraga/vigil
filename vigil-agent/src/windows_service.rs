#![cfg(windows)]

use std::ffi::OsString;
use std::time::Duration;
use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};

const SERVICE_NAME: &str = "VIGILAgent";

define_windows_service!(ffi_service_main, service_main);

fn service_main(arguments: Vec<OsString>) {
    // Parse --config from service arguments (same as CLI args registered with sc create)
    let config_path = arguments
        .windows(2)
        .find(|w| w[0].to_string_lossy() == "--config")
        .and_then(|w| w[1].to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| crate::resolve_config_path("config.toml"));

    if let Err(e) = run_service(config_path) {
        eprintln!("[VIGILAgent] Service error: {e}");
    }
}

fn run_service(config_path: String) -> windows_service::Result<()> {
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();

    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

    // Signal: starting
    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::StartPending,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::from_secs(15),
        process_id: None,
    })?;

    // Spawn monitoring runtime in background thread
    let cfg_path = config_path.clone();
    let monitor_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(crate::run_agent(&cfg_path)) {
            eprintln!("[VIGILAgent] Runtime error: {e}");
        }
    });

    // Signal: running
    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    // Wait for SCM stop signal
    let _ = shutdown_rx.recv();

    // Signal: stopping
    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::StopPending,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    })?;

    // Signal stopped, then force-exit — monitoring thread uses blocking tokio runtime
    // that doesn't respond to SCM stop without a full cancellation framework
    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    // Give logs a moment to flush, then exit cleanly
    std::thread::sleep(Duration::from_millis(500));
    std::process::exit(0);
}

pub fn start_as_service() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}
