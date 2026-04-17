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

    write_private(config_path, content.as_bytes())?;
    tracing::info!("Config written to: {}", config_path);
    Ok(())
}

/// Write a file with owner-only permissions on Unix (0o600). On Windows we
/// rely on inherited ACLs; services run as LocalSystem which restricts access
/// to Administrators by default for files under %ProgramFiles%.
#[cfg(unix)]
fn write_private(path: &str, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    // Ensure mode is 0600 even if the file pre-existed (OpenOptions::mode only
    // applies on create).
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &str, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(windows)]
pub fn install_service(exe_path: &str, config_path: &str) -> Result<()> {
    use std::process::Command;

    // Use simple paths without UNC prefix for service registration
    let exe = std::path::Path::new(exe_path);
    let cfg = std::path::Path::new(config_path)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(config_path));

    // Strip \\?\ UNC prefix if present (not valid in service BinaryPathName)
    let cfg_str = cfg.to_string_lossy();
    let cfg_clean = cfg_str.strip_prefix(r"\\?\").unwrap_or(&cfg_str);
    let exe_str = exe.to_string_lossy();

    // Use PowerShell New-Service — more reliable than sc.exe for quoted paths
    let ps_create = format!(
        r#"New-Service -Name VIGILAgent -BinaryPathName '"{exe}" --config "{cfg}"' -DisplayName "Vigil Monitoring Agent" -StartupType Automatic"#,
        exe = exe_str,
        cfg = cfg_clean,
    );

    let create_out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_create])
        .output()?;

    let create_err = String::from_utf8_lossy(&create_out.stderr);
    let create_stdout = String::from_utf8_lossy(&create_out.stdout);

    if create_out.status.success() || create_err.contains("already exists") || create_stdout.contains("already exists") {
        if create_out.status.success() {
            tracing::info!("Windows service VIGILAgent created");
        } else {
            println!("ℹ️  Service already exists — reconfiguring...");
        }

        // Set failure/recovery actions (restart on crash)
        let _ = Command::new("sc.exe")
            .args(["failure", "VIGILAgent", "reset=", "86400", "actions=", "restart/5000/restart/10000/restart/30000"])
            .output();

        // Start the service
        let start = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Service VIGILAgent -ErrorAction SilentlyContinue"])
            .output()?;

        if start.status.success() {
            println!("✅ Windows service installed and started");
            println!("   Auto-restart on crash: enabled (5s / 10s / 30s)");
        } else {
            println!("✅ Windows service installed");
            println!("⚠️  Could not auto-start — run: Start-Service VIGILAgent");
        }
    } else {
        eprintln!("⚠️  Service install failed: {}{}", create_stdout, create_err);
        println!("   Run manually as Admin:");
        println!(r#"   New-Service -Name VIGILAgent -BinaryPathName '"{exe}" --config "{cfg}"' -DisplayName "Vigil Monitoring Agent" -StartupType Automatic"#,
            exe = exe_str, cfg = cfg_clean);
        println!("   Start-Service VIGILAgent");
        println!(r#"   sc.exe failure VIGILAgent reset= 86400 actions= restart/5000/restart/10000/restart/30000"#);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn install_service(exe_path: &str, config_path: &str) -> Result<()> {
    use std::process::Command;

    let full_config = std::fs::canonicalize(config_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(config_path));

    // Hardened systemd unit: minimum privileges for a monitoring agent.
    // ping needs CAP_NET_RAW on Linux (or setuid ping) — allowed via ambient cap.
    // systemctl is-active works without elevated perms.
    // WorkingDirectory is required: ProtectSystem=strict makes "/" read-only,
    // and the SQLite buffer (relative path by default) would fail to open.
    let config_dir = full_config
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "/var/lib/vigil-agent".to_string());
    let unit = format!(
        "[Unit]\n\
         Description=Vigil Monitoring Agent\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         WorkingDirectory={config_dir}\n\
         ExecStart={exe} --config {config}\n\
         Restart=always\n\
         RestartSec=10\n\
         StandardOutput=journal\n\
         StandardError=journal\n\
         NoNewPrivileges=yes\n\
         ProtectSystem=strict\n\
         ProtectHome=yes\n\
         PrivateTmp=yes\n\
         ProtectKernelTunables=yes\n\
         ProtectKernelModules=yes\n\
         ProtectControlGroups=yes\n\
         RestrictNamespaces=yes\n\
         RestrictSUIDSGID=yes\n\
         LockPersonality=yes\n\
         SystemCallArchitectures=native\n\
         AmbientCapabilities=CAP_NET_RAW\n\
         CapabilityBoundingSet=CAP_NET_RAW\n\
         ReadWritePaths={config_dir}\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        exe = exe_path,
        config = full_config.display(),
        config_dir = config_dir,
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
