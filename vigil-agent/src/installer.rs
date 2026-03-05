use anyhow::Result;

pub fn write_config(hub_url: &str, token: &str, agent_name: &str, config_path: &str) -> Result<()> {
    let content = format!(
        r#"# Vigil Agent Configuration
# Auto-generated during enrollment — edit as needed

hub_url = "{hub_url}"
hub_token = "{token}"
agent_name = "{agent_name}"
auto_update = false
check_interval_secs = 30

[monitors]
# Add Windows service names or Linux systemd unit names to monitor
services = []

# Uncomment to monitor ports:
# [[monitors.ports]]
# host = "localhost"
# port = 80

# Uncomment to monitor HTTP endpoints:
# [[monitors.http]]
# url = "https://example.com"

[resource]
enabled = true
cpu_alert_pct = 90.0
ram_alert_pct = 85.0
disk_alert_pct = 90.0
"#
    );

    std::fs::write(config_path, &content)?;
    tracing::info!("Config written to: {}", config_path);
    Ok(())
}

#[cfg(windows)]
pub fn install_service(exe_path: &str, config_path: &str) -> Result<()> {
    use std::process::Command;

    let full_config = std::fs::canonicalize(config_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(config_path));

    let bin_path = format!(r#""{}" --config "{}""#, exe_path, full_config.display());

    let output = Command::new("sc")
        .args([
            "create",
            "VIGILAgent",
            "binPath=",
            &bin_path,
            "DisplayName=",
            "Vigil Monitoring Agent",
            "start=",
            "auto",
        ])
        .output()?;

    if output.status.success() {
        tracing::info!("Windows service VIGILAgent created");
        let _ = Command::new("sc").args(["start", "VIGILAgent"]).output();
        println!("✅ Windows service installed and started");
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        if err.contains("1073") || err.to_lowercase().contains("already exists") {
            println!("ℹ️  Service already exists");
        } else {
            eprintln!("⚠️  Service install failed: {}", err);
            println!("   Start manually: vigil-agent --config \"{}\"", full_config.display());
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn install_service(exe_path: &str, config_path: &str) -> Result<()> {
    use std::process::Command;

    let full_config = std::fs::canonicalize(config_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(config_path));

    let unit = format!(
        "[Unit]\nDescription=Vigil Monitoring Agent\nAfter=network.target\n\n[Service]\nType=simple\nExecStart={exe} --config {config}\nRestart=always\nRestartSec=10\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n",
        exe = exe_path,
        config = full_config.display()
    );

    std::fs::write("/etc/systemd/system/vigil-agent.service", unit)?;
    let _ = Command::new("systemctl").args(["daemon-reload"]).output();
    let _ = Command::new("systemctl").args(["enable", "--now", "vigil-agent"]).output();
    println!("✅ systemd service installed and started");
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn install_service(_exe_path: &str, config_path: &str) -> Result<()> {
    println!("ℹ️  Auto-service install not supported on this OS");
    println!("   Run manually: vigil-agent --config \"{}\"", config_path);
    Ok(())
}
