//! Binary entrypoint for `vigil-agent`. The heavy lifting lives in the
//! `vigil_agent` library crate (see `src/lib.rs`); this file only handles
//! clap parsing, logging init, service-mode dispatch on Windows, and the
//! `ctl` subcommand.

use anyhow::Result;
use chrono::Utc;
use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::signal;
use tokio::sync::Mutex;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use vigil_agent::{
    buffer, config, doctor, enroll, hub_client, installer, inventory, ipc, ipc_client, monitors,
    resource_sampler, resolve_data_path, result_signing, updater, PROTOCOL_VERSION,
    UPDATE_PUBKEY_FINGERPRINT,
};

// Re-exported at the binary crate root so the Windows service module
// (which is compiled only here, not in the library) can reach it via
// `crate::resolve_config_path`.
#[allow(unused_imports)]
pub use vigil_agent::resolve_config_path;

#[cfg(windows)]
mod windows_service;

/// Vigil monitoring agent — deployed on servers to report health to the Hub.
#[derive(Parser, Debug)]
#[command(name = "vigil-agent", version, about)]
struct Cli {
    #[arg(long, env = "VIGIL_HUB_URL", global = true)]
    hub_url: Option<String>,

    #[arg(long, env = "VIGIL_HUB_TOKEN", global = true)]
    hub_token: Option<String>,

    #[arg(long, env = "VIGIL_AGENT_NAME", global = true)]
    agent_name: Option<String>,

    #[arg(long, default_value_t = false, global = true)]
    auto_update: bool,

    #[arg(long, default_value = "config.toml", global = true)]
    config: String,

    #[arg(long, env = "VIGIL_ENROLL_TOKEN", global = true)]
    enroll: Option<String>,

    /// Register the OS service against an existing config (no enrollment).
    /// Invoked by the MSI installer when config.toml already exists on the
    /// host — the binary itself owns the service-registration logic so MSI
    /// and ad-hoc installs share one code path.
    #[arg(long, default_value_t = false, global = true)]
    install_service: bool,

    /// Stop and delete the OS service. Inverse of `--install-service`. Run
    /// by the MSI uninstaller before file removal so the .exe isn't in use.
    #[arg(long, default_value_t = false, global = true)]
    remove_service: bool,

    /// Skip TLS certificate verification during enrollment. Needed for dev
    /// Hubs with self-signed certs; NEVER use this on untrusted networks.
    #[arg(long, default_value_t = false, env = "VIGIL_INSECURE_SKIP_VERIFY", global = true)]
    insecure_skip_verify: bool,

    /// Log output format. `text` is human-friendly; `json` emits one
    /// RFC3339-timestamped JSON object per event (target, level, fields).
    #[arg(long, env = "VIGIL_LOG_FORMAT", default_value = "text", global = true)]
    log_format: LogFormat,

    /// Mirror tracing output to the given file (in addition to stdout).
    /// Enables `vigilctl tail-log`. If unset, falls back to
    /// `VIGIL_LOG_PATH` env, otherwise no file is written.
    #[arg(long, env = "VIGIL_LOG_PATH", global = true)]
    log_file: Option<String>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum LogFormat {
    Text,
    Json,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run a battery of preflight checks against config + Hub connectivity.
    Doctor,
    /// Print version/build metadata. Pass `--json` for machine-readable output.
    Version {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Local IPC client — talk to a running `vigil-agent` over its socket/pipe.
    Ctl {
        #[command(subcommand)]
        action: CtlAction,
    },
}

#[derive(Subcommand, Debug)]
enum CtlAction {
    /// Show agent status (hub connection, buffer depth, uptime, …).
    Status {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// List the checks the agent knows about.
    List {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Trigger a one-shot run of a specific check by id.
    RunNow { check_id: String },
    /// Silence a check for a duration ("15m", "1h", "4h") or until an ISO timestamp.
    Silence {
        check_id: String,
        duration: String,
    },
    /// Pause all checks for a duration (same syntax as `silence`).
    Pause { duration: String },
    /// Print the last N lines of the agent log file (if `--log-file` was set).
    TailLog {
        #[arg(long, default_value_t = 50)]
        lines: usize,
        #[arg(long, default_value_t = false)]
        follow: bool,
    },
    /// Reload config from disk (intervals + resource thresholds only).
    Reload,
    /// Subscribe to live events — one JSON object per line until Ctrl+C.
    Watch,
}

fn init_logging(format: LogFormat, log_file: Option<&str>) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Registry};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    // If a log file was requested, build a non-blocking appender and return
    // its guard so it outlives `init_logging`.
    let (file_writer, guard) = match log_file {
        Some(path) if !path.is_empty() => {
            let p = std::path::Path::new(path);
            let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
            let file_name = p
                .file_name()
                .map(|n| n.to_os_string())
                .unwrap_or_else(|| std::ffi::OsString::from("vigil-agent.log"));
            let _ = std::fs::create_dir_all(&dir);
            let appender = tracing_appender::rolling::never(&dir, &file_name);
            let (nb, guard) = tracing_appender::non_blocking(appender);
            (Some(nb), Some(guard))
        }
        _ => (None, None),
    };

    match format {
        LogFormat::Text => {
            let stdout_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stdout);
            let file_layer = file_writer.map(|fw| {
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(fw)
            });
            Registry::default()
                .with(filter)
                .with(stdout_layer)
                .with(file_layer)
                .try_init()
                .ok();
        }
        LogFormat::Json => {
            let stdout_layer = tracing_subscriber::fmt::layer()
                .with_target(true)
                .json()
                .flatten_event(true)
                .with_current_span(true)
                .with_span_list(false)
                .with_writer(std::io::stdout);
            let file_layer = file_writer.map(|fw| {
                tracing_subscriber::fmt::layer()
                    .with_target(true)
                    .json()
                    .flatten_event(true)
                    .with_writer(fw)
            });
            Registry::default()
                .with(filter)
                .with(stdout_layer)
                .with(file_layer)
                .try_init()
                .ok();
        }
    }

    guard
}

/// Resolve a log file path: explicit CLI/env, otherwise `<buffer-dir>/agent.log`.
fn resolve_log_file_path(explicit: Option<&str>, buffer_path: &str) -> Option<PathBuf> {
    if let Some(p) = explicit {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let bp = std::path::Path::new(buffer_path);
    let parent = bp.parent().unwrap_or_else(|| std::path::Path::new("."));
    Some(parent.join("agent.log"))
}

/// Main monitoring loop — called from both CLI and Windows service
pub async fn run_agent(config_path: &str) -> Result<()> {
    let mut cfg = config::Config::load(config_path).unwrap_or_else(|e| {
        warn!("Could not load config '{}': {e}. Using defaults.", config_path);
        config::Config::default()
    });

    // Re-anchor a relative buffer path so a service launched from
    // C:\Windows\System32 (or any non-data CWD) writes the SQLite buffer to
    // the Vigil data dir, not the service's working directory.
    cfg.buffer_path = resolve_data_path(&cfg.buffer_path);

    info!(
        agent_name = %cfg.agent_name,
        hub_url = %cfg.hub_url,
        "Starting Vigil agent v{}",
        env!("CARGO_PKG_VERSION")
    );

    let event_buffer = buffer::EventBuffer::new(&cfg.buffer_path)?;
    info!(path = %cfg.buffer_path, "Event buffer initialized");

    // Per-agent ed25519 signing key. Generated once on first run and pinned
    // by the Hub on first register. See result_signing.rs for details.
    let signer = Arc::new(result_signing::ResultSigner::load_or_create(config_path)?);
    info!(
        pubkey = %signer.public_key_hex(),
        "Result signing key loaded"
    );

    let (hub, checks_rx, actions) = hub_client::HubClient::new(
        cfg.hub_url.clone(),
        cfg.hub_token.clone(),
        cfg.agent_name.clone(),
        config_path.to_string(),
        cfg.allow_actions.clone(),
        Arc::clone(&signer),
    );

    let log_file_path = resolve_log_file_path(None, &cfg.buffer_path);
    let signing_pubkey_hex = signer.public_key_hex().to_string();

    info!("Entering main loop — press Ctrl+C to stop");
    run(
        cfg,
        event_buffer,
        hub,
        checks_rx,
        actions,
        config_path.to_string(),
        log_file_path,
        signing_pubkey_hex,
    )
    .await
}

/// Snapshot inventory + spawn the resource sampler. Both are pure side-effects
/// on the host — no Hub round-trips — so it's safe to do this synchronously
/// before we hand off to the WS client.
fn bootstrap_telemetry(
    cfg: &config::Config,
) -> (
    inventory::AgentInventory,
    tokio::sync::mpsc::Receiver<resource_sampler::ResourceSample>,
) {
    let inv = inventory::collect();
    info!(
        arch = %inv.arch,
        cpu_count = inv.cpu_count,
        disks = inv.disks.len(),
        nics = inv.nics.len(),
        container = inv.container.as_deref().unwrap_or("none"),
        "Collected agent inventory"
    );
    let rx = resource_sampler::spawn(cfg.resource.sample_interval_secs);
    info!(
        interval_secs = cfg.resource.sample_interval_secs,
        "Resource sampler started"
    );
    (inv, rx)
}

fn main() {
    // Peek at --log-format early so service-mode dispatch and enrollment also
    // honour the format. Full parse happens later inside async_main.
    let early_format = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|w| {
            if w.first().map(|s| s.as_str()) == Some("--log-format") {
                match w.get(1).map(|s| s.as_str()) {
                    Some("json") => Some(LogFormat::Json),
                    Some("text") => Some(LogFormat::Text),
                    _ => None,
                }
            } else {
                None
            }
        })
        .or_else(|| match std::env::var("VIGIL_LOG_FORMAT").as_deref() {
            Ok("json") => Some(LogFormat::Json),
            _ => None,
        })
        .unwrap_or(LogFormat::Text);

    // Also peek at --log-file so the appender is attached from the very first
    // log line. This is best-effort: the full parse below honours the env+CLI
    // without re-initialising logging.
    let early_log_file = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|w| {
            if w.first().map(|s| s.as_str()) == Some("--log-file") {
                w.get(1).cloned()
            } else {
                None
            }
        })
        .or_else(|| std::env::var("VIGIL_LOG_PATH").ok())
        .filter(|s| !s.is_empty());

    // Keep the guard alive for the lifetime of the process so the async
    // appender flushes on shutdown.
    let _log_guard = init_logging(early_format, early_log_file.as_deref());

    // On Windows: if not an enrollment/CLI invocation, try to dispatch as a service first.
    // service_dispatcher::start() returns immediately with error 1063 if NOT running as service.
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        let is_cli_invocation = args.iter().any(|a| {
            a == "--enroll"
                || a == "--install-service"
                || a == "--remove-service"
                || a == "--help"
                || a == "-h"
                || a == "--version"
                || a == "-V"
                || a == "doctor"
                || a == "version"
                || a == "ctl"
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
    match rt.block_on(async_main()) {
        Ok(exit) => std::process::exit(exit),
        Err(e) => {
            eprintln!("Fatal error: {e}");
            std::process::exit(1);
        }
    }
}

async fn async_main() -> Result<i32> {
    let cli = Cli::parse();

    // Subcommands first — they bypass the enrollment / run flows.
    if let Some(ref cmd) = cli.command {
        match cmd {
            Command::Doctor => {
                let config_path = resolve_config_path(&cli.config);
                let exit = doctor::run(&config_path, cli.insecure_skip_verify).await?;
                return Ok(exit);
            }
            Command::Version { json } => {
                if *json {
                    let v = doctor::version_json();
                    println!("{}", serde_json::to_string_pretty(&v)?);
                } else {
                    println!("vigil-agent {}", env!("CARGO_PKG_VERSION"));
                    println!("  protocol_version: {}", PROTOCOL_VERSION);
                    println!(
                        "  build_sha: {}",
                        option_env!("BUILD_SHA").unwrap_or("unknown")
                    );
                    println!(
                        "  update_pubkey_fingerprint: {}",
                        UPDATE_PUBKEY_FINGERPRINT
                            .as_deref()
                            .unwrap_or("<unset — auto-update disabled>")
                    );
                    println!("  os/arch: {}/{}", std::env::consts::OS, std::env::consts::ARCH);
                }
                return Ok(0);
            }
            Command::Ctl { action } => {
                return run_ctl(action).await;
            }
        }
    }

    // Service-management flags (invoked by the MSI installer / uninstaller).
    // Both short-circuit further processing.
    if cli.remove_service {
        let exit = match installer::remove_service() {
            Ok(()) => {
                println!("✅ Vigil agent service removed");
                0
            }
            Err(e) => {
                eprintln!("⚠️  Service removal failed: {e}");
                // Return 0 anyway — MSI uninstall must not abort because the
                // service was already gone. The error is logged for the operator.
                0
            }
        };
        return Ok(exit);
    }

    if cli.install_service {
        let config_path = resolve_config_path(&cli.config);
        let exe_path = std::env::current_exe()
            .unwrap_or_else(|_| std::path::PathBuf::from("vigil-agent"))
            .to_string_lossy()
            .to_string();
        match installer::install_service(&exe_path, &config_path) {
            Ok(()) => return Ok(0),
            Err(e) => {
                eprintln!("⚠️  Service install failed: {e}");
                return Ok(1);
            }
        }
    }

    // Enrollment flow
    if let Some(ref enrollment_token) = cli.enroll {
        let hub_url = cli.hub_url.as_deref().unwrap_or("http://localhost:3000");
        println!("🔗 Enrolling with Hub at {}...", hub_url);

        match enroll::enroll(hub_url, enrollment_token, cli.insecure_skip_verify).await {
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
                return Ok(0);
            }
            Err(e) => {
                eprintln!("❌ Enrollment failed: {}", e);
                return Ok(1);
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

    // Re-anchor relative buffer paths against the Vigil data dir (see
    // `run_agent` for context).
    cfg.buffer_path = resolve_data_path(&cfg.buffer_path);

    info!(agent_name = %cfg.agent_name, hub_url = %cfg.hub_url,
        "Starting Vigil agent v{}", env!("CARGO_PKG_VERSION"));

    let event_buffer = buffer::EventBuffer::new(&cfg.buffer_path)?;
    info!(path = %cfg.buffer_path, "Event buffer initialized");

    // Per-agent ed25519 signing key. Generated once on first run and pinned
    // by the Hub on first register. See result_signing.rs for details.
    let signer = Arc::new(result_signing::ResultSigner::load_or_create(&config_path)?);
    info!(
        pubkey = %signer.public_key_hex(),
        "Result signing key loaded"
    );

    let (hub, checks_rx, actions) = hub_client::HubClient::new(
        cfg.hub_url.clone(),
        cfg.hub_token.clone(),
        cfg.agent_name.clone(),
        config_path.clone(),
        cfg.allow_actions.clone(),
        Arc::clone(&signer),
    );

    let log_file_path = resolve_log_file_path(cli.log_file.as_deref(), &cfg.buffer_path);
    let signing_pubkey_hex = signer.public_key_hex().to_string();

    info!("Entering main loop — press Ctrl+C to stop");
    run(
        cfg,
        event_buffer,
        hub,
        checks_rx,
        actions,
        config_path.clone(),
        log_file_path,
        signing_pubkey_hex,
    )
    .await?;
    Ok(0)
}

async fn build_remote_monitors(
    checks: &[hub_client::RemoteCheck],
) -> Vec<(String, Box<dyn monitors::Monitor + Send>)> {
    use monitors::{
        cert::CertMonitor, event_log::EventLogMonitor, http::HttpMonitor,
        logfile::{FireOn, LogfileMonitor}, ping::PingMonitor, port::PortMonitor,
        process::ProcessMonitor, resource::ResourceMonitor, service::ServiceMonitor,
    };
    let mut monitors: Vec<(String, Box<dyn monitors::Monitor + Send>)> = Vec::new();
    for c in checks {
        let built: Option<Box<dyn monitors::Monitor + Send>> = match c.check_type.as_str() {
            "http" => {
                let url = c.config.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let expected = c.config.get("expected_status").and_then(|v| v.as_u64()).unwrap_or(200) as u16;
                let timeout = c.config.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(5000);
                let keyword = c.config.get("body_keyword").and_then(|v| v.as_str()).map(|s| s.to_string());
                Some(Box::new(HttpMonitor::new(url, expected, timeout, keyword)))
            }
            "port" => {
                let host = c.config.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let port = c.config.get("port").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                let timeout = c.config.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(3000);
                Some(Box::new(PortMonitor::new(host, port, timeout)))
            }
            "ping" => {
                let host = c.config.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                Some(Box::new(PingMonitor::new(host)))
            }
            "service" => {
                let name = c.config.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                Some(Box::new(ServiceMonitor::new(name)))
            }
            "cert" => {
                let host = c.config.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let port = c.config.get("port").and_then(|v| v.as_u64()).unwrap_or(443) as u16;
                let warn_days = c.config.get("warn_days").and_then(|v| v.as_u64()).unwrap_or(30) as u32;
                Some(Box::new(CertMonitor::new(host, port, warn_days)))
            }
            "resource" => {
                let cpu = c.config.get("cpu_alert_pct").and_then(|v| v.as_f64()).unwrap_or(90.0) as f32;
                let ram = c.config.get("ram_alert_pct").and_then(|v| v.as_f64()).unwrap_or(85.0) as f32;
                let disk = c.config.get("disk_alert_pct").and_then(|v| v.as_f64()).unwrap_or(90.0) as f32;
                Some(Box::new(ResourceMonitor::new(cpu, ram, disk)))
            }
            "process" => {
                let process_name = c
                    .config
                    .get("process_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let min_instances = c
                    .config
                    .get("min_instances")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1) as u32;
                if process_name.is_empty() {
                    warn!("process check '{}' missing process_name — skipping", c.name);
                    None
                } else {
                    Some(Box::new(ProcessMonitor::new(process_name, min_instances)))
                }
            }
            "logfile" => {
                let path = c
                    .config
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let pattern = c
                    .config
                    .get("pattern")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let fire_on = c
                    .config
                    .get("fire_on")
                    .and_then(|v| v.as_str())
                    .map(FireOn::parse)
                    .unwrap_or(FireOn::Match);
                let window_secs = c
                    .config
                    .get("window_secs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(300);
                if path.is_empty() || pattern.is_empty() {
                    warn!(
                        "logfile check '{}' missing path or pattern — skipping",
                        c.name
                    );
                    None
                } else {
                    Some(Box::new(LogfileMonitor::new(
                        path,
                        pattern,
                        fire_on,
                        window_secs,
                    )))
                }
            }
            "event_log" => {
                let channel = c
                    .config
                    .get("channel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("System")
                    .to_string();
                let provider = c
                    .config
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let event_id = c
                    .config
                    .get("event_id")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let window_secs = c
                    .config
                    .get("window_secs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(300);
                if provider.is_empty() || event_id == 0 {
                    warn!(
                        "event_log check '{}' missing provider or event_id — skipping",
                        c.name
                    );
                    None
                } else {
                    Some(Box::new(EventLogMonitor::new(
                        channel,
                        provider,
                        event_id,
                        window_secs,
                    )))
                }
            }
            other => {
                warn!("Unknown check type: {}", other);
                None
            }
        };
        if let Some(m) = built {
            monitors.push((c.id.clone(), m));
        }
    }
    monitors
}

#[allow(clippy::too_many_arguments)]
async fn run(
    cfg: config::Config,
    event_buffer: buffer::EventBuffer,
    hub: hub_client::HubClient,
    mut checks_rx: tokio::sync::watch::Receiver<Vec<hub_client::RemoteCheck>>,
    mut actions: hub_client::ActionChannels,
    config_path: String,
    log_file_path: Option<PathBuf>,
    signing_pubkey_hex: String,
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

    // Monitors pushed from Hub (dynamic, updated on configure_checks messages).
    // Keyed by check_id so we can dispatch `run_check_now` by id.
    let mut remote_monitors: Vec<(String, Box<dyn Monitor + Send>)> = Vec::new();

    let (inventory_snapshot, sample_rx) = bootstrap_telemetry(&cfg);

    let silence = Arc::clone(&actions.silence);
    let dropped_events = hub.drop_counter();

    // -- IPC context + server ---------------------------------------------
    let paused_until = ipc::new_paused_until();
    let check_rows = ipc::new_check_rows();
    let events_tx = ipc::new_event_channel(256);
    let (reload_tx, mut reload_rx) = tokio::sync::watch::channel(0u64);
    let connected = Arc::new(AtomicBool::new(false));
    let agent_id_shared = Arc::new(Mutex::new(None::<String>));

    let ipc_ctx = ipc::IpcContext {
        hub_url: cfg.hub_url.clone(),
        agent_name: cfg.agent_name.clone(),
        agent_id: Arc::clone(&agent_id_shared),
        signing_pubkey_hex,
        connected: Arc::clone(&connected),
        silence: Arc::clone(&silence),
        runnow_tx: actions.runnow_tx_for_ipc.clone(),
        buffer: Arc::clone(&buffer),
        dropped_events: Arc::clone(&dropped_events),
        start: std::time::Instant::now(),
        config_path: config_path.clone(),
        paused_until: Arc::clone(&paused_until),
        events_tx: events_tx.clone(),
        check_rows: Arc::clone(&check_rows),
        reload_tx,
        log_file_path: log_file_path.clone(),
    };

    let (ipc_shutdown_tx, ipc_shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let ipc_ctx_clone = ipc_ctx.clone();
    let ipc_handle = tokio::spawn(async move {
        let shutdown = async move {
            let _ = ipc_shutdown_rx.await;
        };
        if let Err(e) = ipc::serve(ipc_ctx_clone, shutdown).await {
            warn!(error = %e, "ipc server stopped with error");
        }
    });

    // Seed connected=true after first hub run loop iteration; hub_client
    // doesn't expose a direct "connected" state, so we approximate by
    // marking it connected at startup and letting it toggle on hub
    // reconnect events (emitted by the WS loop — see below).
    connected.store(false, Ordering::Relaxed);

    let hub_handle = {
        let buffer = Arc::clone(&buffer);
        let events_tx = events_tx.clone();
        let connected = Arc::clone(&connected);
        let hub_url_for_event = cfg.hub_url.clone();
        tokio::spawn(async move {
            // Announce connected optimistically; hub_client will reconnect
            // internally and real disconnect/reconnect visibility would
            // require extending hub_client's public API — out of scope here.
            let _ = events_tx.send(ipc::AgentEvent::AgentConnected {
                hub_url: hub_url_for_event.clone(),
            });
            connected.store(true, Ordering::Relaxed);
            hub.run(buffer, sample_rx, inventory_snapshot).await;
            connected.store(false, Ordering::Relaxed);
            let _ = events_tx.send(ipc::AgentEvent::AgentDisconnected {
                reason: "hub loop exited".to_string(),
            });
        })
    };

    let updater_handle = if cfg.auto_update {
        let u = updater::Updater::new(&cfg.hub_url, &cfg.hub_token);
        Some(tokio::spawn(async move { u.run().await; }))
    } else {
        None
    };

    // Track the check interval in a mutable local so reload_config can
    // bump it without restarting the interval timer in the common case.
    let mut check_interval_secs = cfg.check_interval_secs;
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(check_interval_secs));

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

    // Track a per-tick paused-log gate so we only log "skipping N checks" once
    // per paused-tick.
    let mut last_pause_log_tick: Option<chrono::DateTime<Utc>> = None;

    loop {
        tokio::select! {
            _ = &mut shutdown => { info!("Graceful shutdown"); break; }

            // IPC-driven reload — re-read config and swap what's safe to swap.
            Ok(()) = reload_rx.changed() => {
                match config::Config::load(&config_path) {
                    Ok(new_cfg) => {
                        if new_cfg.check_interval_secs != check_interval_secs {
                            info!(
                                from = check_interval_secs,
                                to = new_cfg.check_interval_secs,
                                "reloading check interval"
                            );
                            check_interval_secs = new_cfg.check_interval_secs;
                            interval = tokio::time::interval(
                                std::time::Duration::from_secs(check_interval_secs),
                            );
                        }
                        info!("config reloaded");
                    }
                    Err(e) => warn!(error = %e, "config reload failed"),
                }
            }

            // Rebuild remote monitors when Hub pushes new check configs
            Ok(()) = checks_rx.changed() => {
                let checks = checks_rx.borrow().clone();
                info!(count = checks.len(), "Updating remote monitors from Hub");
                remote_monitors = build_remote_monitors(&checks).await;
                // Refresh the IPC-visible list of checks.
                let mut rows = check_rows.lock().await;
                rows.retain(|r| r.source == "local");
                for c in &checks {
                    rows.push(ipc::row_from_remote(c));
                }
            }

            // Hub-initiated run-now: look up the monitor by check_id,
            // execute once, push to buffer with on_demand=true metadata,
            // and ack back over the WS so the Hub can confirm to the user.
            Some(req) = actions.runnow_rx.recv() => {
                let outcome_status: &'static str = if let Some((_, monitor)) =
                    remote_monitors.iter().find(|(id, _)| id == &req.check_id)
                {
                    info!(check_id = %req.check_id, "run_check_now — executing on-demand");
                    let mut result = monitor.check().await;
                    // Tag the result so the Hub can distinguish on-demand runs
                    // from scheduled ones (UI shows a badge, alert engine may skip).
                    let mut meta = result
                        .metadata
                        .unwrap_or_else(|| serde_json::json!({}));
                    if let Some(obj) = meta.as_object_mut() {
                        obj.insert("on_demand".to_string(), serde_json::json!(true));
                    }
                    result.metadata = Some(meta);
                    let event = serde_json::to_string(&result)?;
                    {
                        let mut buf = buffer.lock().await;
                        buf.push(&event)?;
                    }
                    // Emit IPC event + record the result in check_rows.
                    let status_str = format!("{:?}", result.status).to_lowercase();
                    ipc::record_check_result(
                        &check_rows,
                        Some(&req.check_id),
                        &result.monitor_name,
                        &result.monitor_type,
                        &status_str,
                        result.response_time_ms,
                        result.timestamp,
                    )
                    .await;
                    let _ = events_tx.send(ipc::AgentEvent::CheckResult {
                        check_id: Some(req.check_id.clone()),
                        monitor_name: result.monitor_name.clone(),
                        monitor_type: result.monitor_type.clone(),
                        status: status_str,
                        response_time_ms: result.response_time_ms,
                        message: result.message.clone(),
                    });
                    "ok"
                } else {
                    warn!(check_id = %req.check_id, "run_check_now — unknown check_id");
                    "unknown_check"
                };
                let _ = actions
                    .runnow_ack_tx
                    .send(hub_client::RunNowOutcome {
                        check_id: req.check_id,
                        status: outcome_status,
                    })
                    .await;
            }

            _ = interval.tick() => {
                let now = chrono::Utc::now();

                // Paused? Log once per tick and skip.
                let paused = {
                    let p = paused_until.lock().await;
                    p.as_ref().map(|u| *u > now).unwrap_or(false)
                };
                if paused {
                    if last_pause_log_tick.map(|t| (now - t).num_seconds() >= 10).unwrap_or(true) {
                        let total = active_monitors.len() + remote_monitors.len();
                        info!(skipped = total, "[paused] skipping checks");
                        last_pause_log_tick = Some(now);
                    }
                    continue;
                }

                // Run config-file monitors (no per-check silence — they have no hub id).
                for monitor in &active_monitors {
                    let result = monitor.check().await;
                    info!(monitor = %result.monitor_name, status = ?result.status, "Check complete");
                    let event = serde_json::to_string(&result)?;
                    let mut buf = buffer.lock().await;
                    buf.push(&event)?;
                    drop(buf);
                    let status_str = format!("{:?}", result.status).to_lowercase();
                    ipc::record_check_result(
                        &check_rows,
                        None,
                        &result.monitor_name,
                        &result.monitor_type,
                        &status_str,
                        result.response_time_ms,
                        result.timestamp,
                    )
                    .await;
                    let _ = events_tx.send(ipc::AgentEvent::CheckResult {
                        check_id: None,
                        monitor_name: result.monitor_name.clone(),
                        monitor_type: result.monitor_type.clone(),
                        status: status_str,
                        response_time_ms: result.response_time_ms,
                        message: result.message.clone(),
                    });
                }
                // Run Hub-configured monitors; skip any that are silenced.
                // Snapshot the silence map first so we don't hold the lock across .check().await.
                let silenced: std::collections::HashSet<String> = {
                    let map = silence.lock().await;
                    map.iter()
                        .filter_map(|(id, until)| if *until > now { Some(id.clone()) } else { None })
                        .collect()
                };
                for (id, monitor) in &remote_monitors {
                    if silenced.contains(id) {
                        continue;
                    }
                    let result = monitor.check().await;
                    info!(monitor = %result.monitor_name, status = ?result.status, "Check complete");
                    let event = serde_json::to_string(&result)?;
                    let mut buf = buffer.lock().await;
                    buf.push(&event)?;
                    drop(buf);
                    let status_str = format!("{:?}", result.status).to_lowercase();
                    ipc::record_check_result(
                        &check_rows,
                        Some(id),
                        &result.monitor_name,
                        &result.monitor_type,
                        &status_str,
                        result.response_time_ms,
                        result.timestamp,
                    )
                    .await;
                    let _ = events_tx.send(ipc::AgentEvent::CheckResult {
                        check_id: Some(id.clone()),
                        monitor_name: result.monitor_name.clone(),
                        monitor_type: result.monitor_type.clone(),
                        status: status_str,
                        response_time_ms: result.response_time_ms,
                        message: result.message.clone(),
                    });
                }
            }
        }
    }

    hub_handle.abort();
    if let Some(h) = updater_handle { h.abort(); }
    let _ = ipc_shutdown_tx.send(());
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), ipc_handle).await;
    // Silence unused-var on ipc_ctx (held to keep channels alive)
    drop(ipc_ctx);
    info!("Vigil agent stopped");
    Ok(())
}

// -- ctl subcommand implementation ---------------------------------------

async fn run_ctl(action: &CtlAction) -> Result<i32> {
    use serde_json::json;

    match action {
        CtlAction::Status { json: as_json } => {
            let res = ipc_client::call("get_status", json!({})).await?;
            if *as_json {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                print_status(&res);
            }
            Ok(0)
        }
        CtlAction::List { json: as_json } => {
            let res = ipc_client::call("list_checks", json!({})).await?;
            if *as_json {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                print_check_list(&res);
            }
            Ok(0)
        }
        CtlAction::RunNow { check_id } => {
            let res = ipc_client::call("run_check_now", json!({ "check_id": check_id })).await?;
            println!("{}", serde_json::to_string_pretty(&res)?);
            Ok(0)
        }
        CtlAction::Silence { check_id, duration } => {
            let params = if let Some(secs) = parse_duration(duration) {
                json!({ "check_id": check_id, "duration_secs": secs })
            } else {
                json!({ "check_id": check_id, "until_iso": duration })
            };
            let res = ipc_client::call("silence", params).await?;
            println!("{}", serde_json::to_string_pretty(&res)?);
            Ok(0)
        }
        CtlAction::Pause { duration } => {
            let secs = parse_duration(duration)
                .ok_or_else(|| anyhow::anyhow!("invalid duration: {duration} (try '15m', '1h', '4h')"))?;
            let res = ipc_client::call("pause_all", json!({ "duration_secs": secs })).await?;
            println!("{}", serde_json::to_string_pretty(&res)?);
            Ok(0)
        }
        CtlAction::TailLog { lines, follow } => {
            let res = ipc_client::call("tail_log", json!({ "lines": *lines })).await?;
            if let Some(arr) = res.get("lines").and_then(|v| v.as_array()) {
                for l in arr {
                    if let Some(s) = l.as_str() {
                        println!("{s}");
                    }
                }
            }
            if *follow {
                // Subscribe to events and stream anything tagged as log on the
                // server side. For v1 we just stream all events — callers can
                // filter client-side.
                let mut stream = ipc_client::subscribe_stream().await?;
                stream
                    .send(
                        json!({"jsonrpc":"2.0","id":1,"method":"subscribe_events"})
                            .to_string(),
                    )
                    .await?;
                while let Some(res) = stream.next_line().await {
                    let line = res?;
                    println!("{line}");
                }
            }
            Ok(0)
        }
        CtlAction::Reload => {
            let res = ipc_client::call("reload_config", json!({})).await?;
            println!("{}", serde_json::to_string_pretty(&res)?);
            Ok(0)
        }
        CtlAction::Watch => {
            let mut stream = ipc_client::subscribe_stream().await?;
            stream
                .send(
                    json!({"jsonrpc":"2.0","id":1,"method":"subscribe_events"})
                        .to_string(),
                )
                .await?;
            // Handle Ctrl+C so we exit cleanly instead of dying mid-read.
            let ctrlc = signal::ctrl_c();
            tokio::pin!(ctrlc);
            loop {
                tokio::select! {
                    _ = &mut ctrlc => { break; }
                    line = stream.next_line() => {
                        match line {
                            Some(Ok(l)) => println!("{l}"),
                            Some(Err(e)) => {
                                eprintln!("stream error: {e}");
                                return Ok(1);
                            }
                            None => break,
                        }
                    }
                }
            }
            Ok(0)
        }
    }
}

/// Parse `15m`, `1h`, `4h`, `90s` — returns seconds, or None if the input
/// looks like an ISO timestamp / unparseable.
fn parse_duration(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Looks like ISO timestamp? Let the server parse it.
    if s.contains('T') || s.contains('-') && s.len() > 8 {
        return None;
    }
    let (num_part, unit) = s.split_at(s.len() - 1);
    let mul: u64 = match unit {
        "s" | "S" => 1,
        "m" | "M" => 60,
        "h" | "H" => 3600,
        "d" | "D" => 86400,
        _ => return s.parse::<u64>().ok(),
    };
    num_part.parse::<u64>().ok().map(|n| n * mul)
}

fn print_status(res: &serde_json::Value) {
    let connected = res["connected"].as_bool().unwrap_or(false);
    let indicator = if connected { "●" } else { "○" };
    println!("{} Vigil agent (v{})",
        indicator,
        res["version"].as_str().unwrap_or("?"));
    println!("  agent_name: {}", res["agent_name"].as_str().unwrap_or("?"));
    if let Some(id) = res["agent_id"].as_str() {
        println!("  agent_id:   {id}");
    }
    println!("  hub_url:    {}", res["hub_url"].as_str().unwrap_or("?"));
    println!("  connected:  {connected}");
    println!("  uptime_secs: {}", res["uptime_secs"].as_u64().unwrap_or(0));
    println!("  checks:     {}", res["check_count"].as_u64().unwrap_or(0));
    println!("  buffer:     {} event(s)", res["buffer_depth"].as_u64().unwrap_or(0));
    println!("  dropped:    {}", res["dropped_events"].as_u64().unwrap_or(0));
    if let Some(pk) = res["signing_pubkey_prefix"].as_str() {
        println!("  signing_pk: {pk}…");
    }
    if let Some(until) = res["paused_until"].as_str() {
        println!("  paused until: {until}");
    }
}

fn print_check_list(res: &serde_json::Value) {
    let empty = Vec::new();
    let rows = res.as_array().unwrap_or(&empty);
    if rows.is_empty() {
        println!("No checks configured yet.");
        return;
    }
    println!(
        "{:<20} {:<10} {:<30} {:<10} {:<25} {}",
        "NAME", "TYPE", "TARGET", "STATUS", "LAST", "SILENCED"
    );
    for r in rows {
        let name = r["name"].as_str().unwrap_or("-");
        let typ = r["type"].as_str().unwrap_or("-");
        let target = r["target"].as_str().unwrap_or("-");
        let status = r["status_last"].as_str().unwrap_or("-");
        let last = r["last_checked"].as_str().unwrap_or("-");
        let sil = r["silenced_until"].as_str().unwrap_or("-");
        println!(
            "{:<20} {:<10} {:<30} {:<10} {:<25} {}",
            truncate(name, 20),
            truncate(typ, 10),
            truncate(target, 30),
            truncate(status, 10),
            truncate(last, 25),
            sil
        );
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
