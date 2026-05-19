# Vigil Agent

The agent is a single statically-linked Rust binary. It runs on monitored servers, executes health checks, and streams results to the Hub over WebSocket.

## CLI Reference

```
vigil-agent [OPTIONS]

Options:
  --config <CONFIG>       Path to config.toml [default: config.toml]
  --enroll <TOKEN>        Enrollment token from Hub
  --hub-url <URL>         Hub URL (required with --enroll)
  --install               Install as system service (after enrollment)
  --version               Print version
  --help                  Print help
```

### Enroll a new agent
```bash
vigil-agent --enroll XWZK-NBT6 --hub-url http://192.168.9.113:3000
# Agent auto-detects hostname, installs config + systemd/SCM service
```

## Config File Reference (`config.toml`)

```toml
# Agent identity
agent_name = "my-server"           # Display name in Hub
hub_url = "http://hub:3000"        # Hub WebSocket base URL
hub_token = "abc123..."            # Token assigned during enrollment

# Behavior
check_interval_secs = 60           # How often to run checks (seconds)
buffer_path = "/var/lib/vigil/events.db"  # SQLite buffer path
auto_update = false                # Auto-update from Hub (experimental)

# Config-file defined monitors (optional — Hub UI is preferred)
[monitors]
services = ["nginx", "postgresql"] # Services to monitor (systemctl/sc status)
ping = ["8.8.8.8", "1.1.1.1"]    # Hosts to ping

[[monitors.http]]
url = "https://myapp.example.com/health"
expected_status = 200
timeout_ms = 5000
body_keyword = "ok"               # Optional: check response body

[[monitors.port]]
host = "db.internal"
port = 5432
timeout_ms = 3000

[[monitors.cert]]
host = "myapp.example.com"
port = 443
warn_days = 30

[monitors.resource]
enabled = true
cpu_alert_pct = 90.0
ram_alert_pct = 85.0
disk_alert_pct = 90.0
```

> **Tip:** Prefer defining checks via the Hub UI (Checks page). The Hub pushes checks to connected agents automatically. Config-file monitors run in parallel with Hub-pushed checks.

## Linux Installation

### Manual
```bash
# Install binary
sudo mkdir -p /opt/vigil
sudo cp vigil-agent /opt/vigil/
sudo chmod +x /opt/vigil/vigil-agent

# Enroll (creates config + installs systemd service)
sudo /opt/vigil/vigil-agent \
  --enroll YOUR_TOKEN \
  --hub-url http://HUB_IP:3000 \
  --config /opt/vigil/config.toml

# Approve in Hub, then agent auto-connects
```

### Service management
```bash
systemctl start vigil-agent
systemctl stop vigil-agent
systemctl restart vigil-agent
systemctl status vigil-agent
journalctl -u vigil-agent -f
```

### Systemd unit (auto-created by installer)
```ini
[Unit]
Description=Vigil Monitoring Agent
After=network.target

[Service]
ExecStart=/opt/vigil/vigil-agent --config /opt/vigil/config.toml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Windows Installation

The supported install path is the MSI served by the Hub. It bundles
`vigil-agent.exe` and `vigil-tray.exe`, installs them under
`C:\Program Files\Vigil\`, creates `C:\ProgramData\Vigil\` for config +
buffer + logs, registers the `VIGILAgent` service with crash recovery, and
optionally enrolls the host during install. See
[INSTALLER.md](INSTALLER.md) for the full reference (GPO/Intune,
upgrade semantics, SmartScreen note).

### Silent install (PowerShell as Administrator)
```powershell
$token = "XWZK-NBT6"               # one-shot enrollment token from the Hub
$hub   = "http://HUB_IP:3000"

Invoke-WebRequest "$hub/api/install/agent/windows/amd64?token=$token" `
  -OutFile vigil-agent.msi

msiexec /i vigil-agent.msi /qn `
  VIGIL_ENROLL_TOKEN=$token `
  VIGIL_HUB_URL=$hub
```

The MSI's custom action runs `vigil-agent --enroll`, which writes
`C:\ProgramData\Vigil\config.toml`, registers the `VIGILAgent` service
(restart policy: 5s / 10s / 30s), and starts it. Approve the host from the
Hub dashboard to begin reporting.

### Reinstall / repair without a token
If `C:\ProgramData\Vigil\config.toml` already exists, the MSI skips
enrollment and re-registers the service against the existing config — safe
to re-run on an already-configured host without clobbering its identity.

### Service management (PowerShell)
```powershell
Start-Service VIGILAgent
Stop-Service VIGILAgent
Restart-Service VIGILAgent
Get-Service VIGILAgent

# View event log
Get-EventLog -LogName Application -Source VIGILAgent -Newest 20
```

### Uninstall
```powershell
# Either: msiexec, with the product code from `wmic product where "Name='Vigil Monitoring Agent'" get IdentifyingNumber`
msiexec /x "{<product-code>}" /qn

# Or: Settings → Apps → Vigil Monitoring Agent → Uninstall
```

The uninstaller stops + deletes the `VIGILAgent` service and removes
`C:\Program Files\Vigil\`. **`C:\ProgramData\Vigil\` is preserved**, so a
fresh install (with or without a new enrollment token) can pick up the
same host identity.

## Monitor Types (from config.toml)

### HTTP
```toml
[[monitors.http]]
url = "https://example.com/health"
expected_status = 200
timeout_ms = 5000
body_keyword = "healthy"   # Optional
```
Alert triggers: non-200 status, timeout, keyword not found.

### Port
```toml
[[monitors.port]]
host = "db.internal"
port = 5432
timeout_ms = 3000
```
Alert triggers: connection refused, timeout.

### Ping
```toml
ping = ["8.8.8.8", "gateway.local"]
```
Alert triggers: no response.

### Service
```toml
services = ["nginx", "postgresql"]   # Linux: systemctl
services = ["Spooler", "WinDefend"]  # Windows: sc query
```
Alert triggers: service not running.

### Certificate (TLS)
```toml
[[monitors.cert]]
host = "example.com"
port = 443
warn_days = 30
```
Alert triggers: expires within `warn_days` (warning), or expired (critical). No alert when OK.

### Resource
```toml
[monitors.resource]
enabled = true
cpu_alert_pct = 90.0
ram_alert_pct = 85.0
disk_alert_pct = 90.0
```
Alert triggers: CPU/RAM/Disk exceeds threshold.

## Offline Buffering

The agent uses a local SQLite database (`buffer_path`) to buffer check results when the Hub is unreachable. Results are replayed to the Hub in order when the connection is restored.

## Building from Source

```bash
# Linux (native)
cargo build --release --bin vigil-agent

# Windows (cross-compile from Linux)
rustup target add x86_64-pc-windows-gnu
cargo build --target x86_64-pc-windows-gnu --release
# Output: target/x86_64-pc-windows-gnu/release/vigil-agent.exe
```
