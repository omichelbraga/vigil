mod buffer;
mod config;
mod enroll;
mod hub_client;
mod installer;
mod monitors;
mod updater;

#[cfg(windows)]
mod windows_service;

use anyhow::Result;
use clap::Parser;
use std::sync::Arc;
use tokio::signal;
use tokio::sync::Mutex;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

/// Vigil monitoring agent — deployed on servers to report health to the Hub.
#[derive(Parser, Debug)]
#[command(name = "vigil-agent", version, about)]
struct Cli {
    #[arg(long, env = "VIGIL_HUB_URL")]
    hub_url: Option<String>,

    #[arg(long, env = "VIGIL_HUB_TOKEN")]
    hub_token: Option<String>,

    #[arg(long, env = "VIGIL_AGENT_NAME")]
    agent_name: Option<String>,

    #[arg(long, default_value_t = false)]
    auto_update: bool,

    #[arg(long, default_value = "config.toml")]
    config: String,

    #[arg(long, env = "VIGIL_ENROLL_TOKEN")]
    enroll: Option<String>,
}

fn init_logging() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

/// Resolve config path relative to the exe directory (works when running as a service)
pub fn resolve_config_path(given: &str) -> String {
    let p = std::path::Path::new(given);
    if p.is_absolute() {
        return given.to_string();
    }
    // Try next to the exe first
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(given);
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
            // Return the exe-relative path even if it doesn't exist yet
            return candidate.to_string_lossy().to_string();
        }
    }
    given.to_string()
}

/// Main monitoring loop — called from both CLI and Windows service
pub async fn run_agent(config_path: &str) -> Result<()> {
    let mut cfg = config::Config::load(config_path).unwrap_or_else(|e| {
        warn!("Could not load config '{}': {e}. Using defaults.", config_path);
        config::Config::default()
    });

    info!(
        agent_name = %cfg.agent_name,
        hub_url = %cfg.hub_url,
        "Starting Vigil agent v{}",
        env!("CARGO_PKG_VERSION")
    );

    let event_buffer = buffer::EventBuffer::new(&cfg.buffer_path)?;
    info!(path = %cfg.buffer_path, "Event buffer initialized");

    let (hub, checks_rx) = hub_client::HubClient::new(
        cfg.hub_url.clone(),
        cfg.hub_token.clone(),
        cfg.agent_name.clone(),
    );

    info!("Entering main loop — press Ctrl+C to stop");
    run(cfg, event_buffer, hub, checks_rx).await
}

fn main() {
    init_logging();

    // On Windows: if not an enrollment/CLI invocation, try to dispatch as a service first.
    // service_dispatcher::start() returns immediately with error 1063 if NOT running as service.
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        let is_cli_invocation = args.iter().any(|a| {
            a == "--enroll" || a == "--help" || a == "-h" || a == "--version" || a == "-V"
        });

        if !is_cli_invocation {
            if let Ok(()) = windows_service::start_as_service() {
                // Ran as service — done
                return;
            }
            // Error 1063 = not started as service, continue as normal CLI
        }
    }

    // Normal CLI / tokio flow
    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    if let Err(e) = rt.block_on(async_main()) {
        eprintln!("Fatal error: {e}");
        std::process::exit(1);
    }
}

async fn async_main() -> Result<()> {
    let cli = Cli::parse();

    // Enrollment flow
    if let Some(ref enrollment_token) = cli.enroll {
        let hub_url = cli.hub_url.as_deref().unwrap_or("http://localhost:3000");
        println!("🔗 Enrolling with Hub at {}...", hub_url);

        match enroll::enroll(hub_url, enrollment_token).await {
            Ok((agent_id, token)) => {
                let hostname = sysinfo::System::host_name()
                    .unwrap_or_else(|| "vigil-agent".to_string());
                let config_path = resolve_config_path(&cli.config);

                println!("✅ Enrollment successful — Agent ID: {}", agent_id);
                println!("⏳ Waiting for admin approval in the Hub portal...");
                println!("   Dashboard: {}", hub_url);

                installer::write_config(hub_url, &token, &hostname, &config_path)?;

                let exe_path = std::env::current_exe()
                    .unwrap_or_else(|_| std::path::PathBuf::from("vigil-agent"))
                    .to_string_lossy()
                    .to_string();

                if let Err(e) = installer::install_service(&exe_path, &config_path) {
                    eprintln!("⚠️  Service install skipped: {}", e);
                }

                println!();
                println!("🎉 Done! Approve this agent in the Hub portal to start monitoring.");
                return Ok(());
            }
            Err(e) => {
                eprintln!("❌ Enrollment failed: {}", e);
                std::process::exit(1);
            }
        }
    }

    // Normal run
    let config_path = resolve_config_path(&cli.config);
    let mut cfg = config::Config::load(&config_path).unwrap_or_else(|e| {
        warn!("Could not load config '{}': {e}. Using defaults.", config_path);
        config::Config::default()
    });

    if let Some(url) = cli.hub_url { cfg.hub_url = url; }
    if let Some(token) = cli.hub_token { cfg.hub_token = token; }
    if let Some(name) = cli.agent_name { cfg.agent_name = name; }
    if cli.auto_update { cfg.auto_update = true; }

    info!(agent_name = %cfg.agent_name, hub_url = %cfg.hub_url,
        "Starting Vigil agent v{}", env!("CARGO_PKG_VERSION"));

    let event_buffer = buffer::EventBuffer::new(&cfg.buffer_path)?;
    info!(path = %cfg.buffer_path, "Event buffer initialized");

    let (hub, checks_rx) = hub_client::HubClient::new(
        cfg.hub_url.clone(), cfg.hub_token.clone(), cfg.agent_name.clone(),
    );

    info!("Entering main loop — press Ctrl+C to stop");
    run(cfg, event_buffer, hub, checks_rx).await
}

async fn build_remote_monitors(checks: &[hub_client::RemoteCheck]) -> Vec<Box<dyn monitors::Monitor + Send>> {
    use monitors::{
        cert::CertMonitor, http::HttpMonitor, ping::PingMonitor, port::PortMonitor,
        resource::ResourceMonitor, service::ServiceMonitor,
    };
    let mut monitors: Vec<Box<dyn monitors::Monitor + Send>> = Vec::new();
    for c in checks {
        match c.check_type.as_str() {
            "http" => {
                let url = c.config.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let expected = c.config.get("expected_status").and_then(|v| v.as_u64()).unwrap_or(200) as u16;
                let timeout = c.config.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(5000);
                let keyword = c.config.get("body_keyword").and_then(|v| v.as_str()).map(|s| s.to_string());
                monitors.push(Box::new(HttpMonitor::new(url, expected, timeout, keyword)));
            }
            "port" => {
                let host = c.config.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let port = c.config.get("port").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                let timeout = c.config.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(3000);
                monitors.push(Box::new(PortMonitor::new(host, port, timeout)));
            }
            "ping" => {
                let host = c.config.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                monitors.push(Box::new(PingMonitor::new(host)));
            }
            "service" => {
                let name = c.config.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                monitors.push(Box::new(ServiceMonitor::new(name)));
            }
            "cert" => {
                let host = c.config.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let port = c.config.get("port").and_then(|v| v.as_u64()).unwrap_or(443) as u16;
                let warn_days = c.config.get("warn_days").and_then(|v| v.as_u64()).unwrap_or(30) as u32;
                monitors.push(Box::new(CertMonitor::new(host, port, warn_days)));
            }
            "resource" => {
                let cpu = c.config.get("cpu_alert_pct").and_then(|v| v.as_f64()).unwrap_or(90.0) as f32;
                let ram = c.config.get("ram_alert_pct").and_then(|v| v.as_f64()).unwrap_or(85.0) as f32;
                let disk = c.config.get("disk_alert_pct").and_then(|v| v.as_f64()).unwrap_or(90.0) as f32;
                monitors.push(Box::new(ResourceMonitor::new(cpu, ram, disk)));
            }
            _ => { warn!("Unknown check type: {}", c.check_type); }
        }
    }
    monitors
}

async fn run(
    cfg: config::Config,
    event_buffer: buffer::EventBuffer,
    hub: hub_client::HubClient,
    mut checks_rx: tokio::sync::watch::Receiver<Vec<hub_client::RemoteCheck>>,
) -> Result<()> {
    use monitors::{
        cert::CertMonitor, http::HttpMonitor, ping::PingMonitor, port::PortMonitor,
        resource::ResourceMonitor, service::ServiceMonitor, Monitor,
    };

    let buffer = Arc::new(Mutex::new(event_buffer));

    let mut active_monitors: Vec<Box<dyn Monitor + Send>> = Vec::new();

    for svc in &cfg.monitors.services {
        active_monitors.push(Box::new(ServiceMonitor::new(svc.clone())));
    }
    for p in &cfg.monitors.ports {
        active_monitors.push(Box::new(PortMonitor::new(p.host.clone(), p.port, p.timeout_ms)));
    }
    for h in &cfg.monitors.http {
        active_monitors.push(Box::new(HttpMonitor::new(
            h.url.clone(), h.expected_status, h.timeout_ms, h.body_keyword.clone(),
        )));
    }
    for target in &cfg.monitors.ping {
        active_monitors.push(Box::new(PingMonitor::new(target.clone())));
    }
    for c in &cfg.monitors.certs {
        active_monitors.push(Box::new(CertMonitor::new(
            c.host.clone(), c.port.unwrap_or(443), c.warn_days.unwrap_or(30),
        )));
    }
    if cfg.resource.enabled {
        active_monitors.push(Box::new(ResourceMonitor::new(
            cfg.resource.cpu_alert_pct,
            cfg.resource.ram_alert_pct,
            cfg.resource.disk_alert_pct,
        )));
    }

    info!(count = active_monitors.len(), "Monitors loaded from config");

    // Monitors pushed from Hub (dynamic, updated on configure_checks messages)
    let mut remote_monitors: Vec<Box<dyn Monitor + Send>> = Vec::new();

    let hub_handle = {
        let buffer = Arc::clone(&buffer);
        tokio::spawn(async move { hub.run(buffer).await; })
    };

    let updater_handle = if cfg.auto_update {
        let u = updater::Updater::new(&cfg.hub_url, &cfg.hub_token);
        Some(tokio::spawn(async move { u.run().await; }))
    } else {
        None
    };

    let check_interval = std::time::Duration::from_secs(cfg.check_interval_secs);
    let mut interval = tokio::time::interval(check_interval);

    let shutdown = async {
        #[cfg(unix)]
        {
            let mut sigint = signal::unix::signal(signal::unix::SignalKind::interrupt())
                .expect("SIGINT");
            let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())
                .expect("SIGTERM");
            tokio::select! {
                _ = sigint.recv() => info!("SIGINT received"),
                _ = sigterm.recv() => info!("SIGTERM received"),
            }
        }
        #[cfg(windows)]
        {
            signal::ctrl_c().await.expect("Ctrl+C");
            info!("Ctrl+C received");
        }
    };

    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            _ = &mut shutdown => { info!("Graceful shutdown"); break; }

            // Rebuild remote monitors when Hub pushes new check configs
            Ok(()) = checks_rx.changed() => {
                let checks = checks_rx.borrow().clone();
                info!(count = checks.len(), "Updating remote monitors from Hub");
                remote_monitors = build_remote_monitors(&checks).await;
            }

            _ = interval.tick() => {
                // Run config-file monitors
                for monitor in &active_monitors {
                    let result = monitor.check().await;
                    info!(monitor = %result.monitor_name, status = ?result.status, "Check complete");
                    let event = serde_json::to_string(&result)?;
                    let mut buf = buffer.lock().await;
                    buf.push(&event)?;
                }
                // Run Hub-configured monitors
                for monitor in &remote_monitors {
                    let result = monitor.check().await;
                    info!(monitor = %result.monitor_name, status = ?result.status, "Check complete");
                    let event = serde_json::to_string(&result)?;
                    let mut buf = buffer.lock().await;
                    buf.push(&event)?;
                }
            }
        }
    }

    hub_handle.abort();
    if let Some(h) = updater_handle { h.abort(); }
    info!("Vigil agent stopped");
    Ok(())
}
