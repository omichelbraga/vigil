mod buffer;
mod config;
mod hub_client;
mod monitors;
mod updater;

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
    /// WebSocket URL of the Vigil Hub (e.g. wss://hub.example.com/ws)
    #[arg(long, env = "VIGIL_HUB_URL")]
    hub_url: Option<String>,

    /// Authentication token for the Hub
    #[arg(long, env = "VIGIL_HUB_TOKEN")]
    hub_token: Option<String>,

    /// Display name for this agent
    #[arg(long, env = "VIGIL_AGENT_NAME")]
    agent_name: Option<String>,

    /// Enable automatic self-updates from Hub
    #[arg(long, default_value_t = false)]
    auto_update: bool,

    /// Path to configuration file
    #[arg(long, default_value = "config.toml")]
    config: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    let mut cfg = config::Config::load(&cli.config).unwrap_or_else(|e| {
        warn!("Could not load config file '{}': {e}. Using defaults.", cli.config);
        config::Config::default()
    });

    // CLI args override config file values
    if let Some(url) = cli.hub_url {
        cfg.hub_url = url;
    }
    if let Some(token) = cli.hub_token {
        cfg.hub_token = token;
    }
    if let Some(name) = cli.agent_name {
        cfg.agent_name = name;
    }
    if cli.auto_update {
        cfg.auto_update = true;
    }

    info!(
        agent_name = %cfg.agent_name,
        hub_url = %cfg.hub_url,
        "Starting Vigil agent v{}",
        env!("CARGO_PKG_VERSION")
    );

    // Initialize the local SQLite buffer
    let event_buffer = buffer::EventBuffer::new(&cfg.buffer_path)?;
    info!(path = %cfg.buffer_path, "Event buffer initialized");

    // Initialize the Hub WebSocket client
    let hub = hub_client::HubClient::new(
        cfg.hub_url.clone(),
        cfg.hub_token.clone(),
        cfg.agent_name.clone(),
    );

    // Run the main monitoring loop
    info!("Entering main loop — press Ctrl+C to stop");
    run(cfg, event_buffer, hub).await
}

async fn run(
    cfg: config::Config,
    event_buffer: buffer::EventBuffer,
    hub: hub_client::HubClient,
) -> Result<()> {
    use monitors::{
        cert::CertMonitor, http::HttpMonitor, ping::PingMonitor, port::PortMonitor,
        resource::ResourceMonitor, service::ServiceMonitor, Monitor,
    };

    let buffer = Arc::new(Mutex::new(event_buffer));

    // Build monitors from config
    let mut active_monitors: Vec<Box<dyn Monitor + Send>> = Vec::new();

    for svc in &cfg.monitors.services {
        active_monitors.push(Box::new(ServiceMonitor::new(svc.clone())));
    }
    for p in &cfg.monitors.ports {
        active_monitors.push(Box::new(PortMonitor::new(
            p.host.clone(),
            p.port,
            p.timeout_ms,
        )));
    }
    for h in &cfg.monitors.http {
        active_monitors.push(Box::new(HttpMonitor::new(
            h.url.clone(),
            h.expected_status,
            h.timeout_ms,
            h.body_keyword.clone(),
        )));
    }
    for target in &cfg.monitors.ping {
        active_monitors.push(Box::new(PingMonitor::new(target.clone())));
    }
    for c in &cfg.monitors.certs {
        active_monitors.push(Box::new(CertMonitor::new(
            c.host.clone(),
            c.port.unwrap_or(443),
            c.warn_days.unwrap_or(30),
        )));
    }
    if cfg.resource.enabled {
        active_monitors.push(Box::new(ResourceMonitor::new(
            cfg.resource.cpu_alert_pct,
            cfg.resource.ram_alert_pct,
            cfg.resource.disk_alert_pct,
        )));
    }

    info!(count = active_monitors.len(), "Monitors loaded");

    // Spawn Hub connection task
    let hub_handle = {
        let buffer = Arc::clone(&buffer);
        tokio::spawn(async move {
            hub.run(buffer).await;
        })
    };

    // Spawn auto-updater if enabled
    let updater_handle = if cfg.auto_update {
        let u = updater::Updater::new(&cfg.hub_url, &cfg.hub_token);
        Some(tokio::spawn(async move {
            u.run().await;
        }))
    } else {
        None
    };

    // Monitoring loop with graceful shutdown
    let check_interval = std::time::Duration::from_secs(cfg.check_interval_secs);
    let mut interval = tokio::time::interval(check_interval);

    let shutdown = async {
        #[cfg(unix)]
        {
            let mut sigint = signal::unix::signal(signal::unix::SignalKind::interrupt())
                .expect("Failed to register SIGINT handler");
            let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())
                .expect("Failed to register SIGTERM handler");
            tokio::select! {
                _ = sigint.recv() => info!("Received SIGINT, shutting down"),
                _ = sigterm.recv() => info!("Received SIGTERM, shutting down"),
            }
        }
        #[cfg(windows)]
        {
            signal::ctrl_c().await.expect("Failed to register Ctrl+C handler");
            info!("Received Ctrl+C, shutting down");
        }
    };

    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                info!("Graceful shutdown initiated");
                break;
            }
            _ = interval.tick() => {
                for monitor in &active_monitors {
                    let result = monitor.check().await;
                    info!(
                        monitor = %result.monitor_name,
                        status = ?result.status,
                        "Check complete"
                    );

                    let event = serde_json::to_string(&result)?;
                    let mut buf = buffer.lock().await;
                    buf.push(&event)?;
                }
            }
        }
    }

    // Cleanup
    hub_handle.abort();
    if let Some(h) = updater_handle {
        h.abort();
    }

    info!("Vigil agent stopped");
    Ok(())
}
