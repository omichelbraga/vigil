# Vigil Quickstart Guide

Deploy Vigil from scratch in ~15 minutes.

## Prerequisites

- Linux server (Ubuntu 22.04+ or Debian 12+)
- Node.js 20+ and npm
- Docker (for PostgreSQL)
- Rust toolchain (for building agents from source)
- `systemd` (user services)

## 1. Clone the Repository

```bash
git clone https://github.com/omichelbraga/vigil.git
cd vigil
```

## 2. Start PostgreSQL

```bash
docker run -d \
  --name vigil-postgres \
  -e POSTGRES_DB=vigil \
  -e POSTGRES_USER=vigil \
  -e POSTGRES_PASSWORD=your_strong_password \
  -p 5433:5432 \
  --restart unless-stopped \
  postgres:16
```

## 3. Configure the Hub

```bash
cd vigil-hub
cp .env.example .env   # or create .env manually
```

Edit `.env`:

```env
DATABASE_URL=postgresql://vigil:your_strong_password@localhost:5433/vigil
BETTER_AUTH_SECRET=<generate: openssl rand -hex 32>
BETTER_AUTH_URL=http://YOUR_SERVER_IP:3000
ENCRYPTION_KEY=<generate: openssl rand -hex 32>
NODE_ENV=production
```

Initialize the database:

```bash
npx prisma db push
```

## 4. Build the Hub

```bash
cd vigil-hub
npm install
npx next build
```

## 5. Install Hub as a systemd Service

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/vigil-hub.service << 'EOF'
[Unit]
Description=Vigil Hub - Server Monitoring Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/YOUR_USER/path/to/vigil/vigil-hub
ExecStart=/usr/bin/node /path/to/tsx/dist/cli.mjs server.ts
Environment=NODE_ENV=production
Restart=always
RestartSec=5
StandardOutput=append:/tmp/vigil-hub.log
StandardError=append:/tmp/vigil-hub.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable vigil-hub
systemctl --user start vigil-hub
```

Check it's running:

```bash
curl http://localhost:3000/api/health
# Should return: {"status":"ok"}
```

## 6. First Login (Setup Wizard)

Open `http://YOUR_SERVER_IP:3000` in a browser. You'll be redirected to the setup wizard to create your admin account.

## 7. Deploy Your First Agent

### Linux Agent

```bash
# Build from source
cd vigil
cargo build --release --bin vigil-agent

# Install binary
sudo mkdir -p /opt/vigil
sudo cp target/release/vigil-agent /opt/vigil/vigil-agent
sudo chmod +x /opt/vigil/vigil-agent

# Get an enrollment token from the Hub:
# Settings → Enrollment → Generate Token

# Enroll the agent
sudo /opt/vigil/vigil-agent \
  --enroll YOUR_TOKEN \
  --hub-url http://YOUR_HUB_IP:3000 \
  --config /opt/vigil/config.toml

# Approve in Hub: Agents → Approve pending agent
```

### Windows Agent (MSI installer)

The Hub serves a Windows MSI at a token-gated install URL. The MSI installs
`vigil-agent.exe` and `vigil-tray.exe` to `C:\Program Files\Vigil\`, creates
`C:\ProgramData\Vigil\` for config + buffer + logs, enrolls with the Hub,
and registers the `VIGILAgent` service.

1. In the Hub, **Agents → Add agent** → copy the install command (already
   contains your one-shot enrollment token).
2. Open PowerShell **as Administrator** on the target host.
3. Run:
```powershell
$token = "XWZK-NBT6"  # one-shot enrollment token from the Hub
$hub   = "http://YOUR_HUB_IP:3000"

Invoke-WebRequest "$hub/api/install/agent/windows/amd64?token=$token" `
  -OutFile vigil-agent.msi

msiexec /i vigil-agent.msi /qn `
  VIGIL_ENROLL_TOKEN=$token `
  VIGIL_HUB_URL=$hub
```
4. Approve the host in the Hub dashboard.

Service control:
```powershell
Get-Service VIGILAgent      # status
Restart-Service VIGILAgent  # restart
msiexec /x {ProductCode} /qn  # uninstall (or use Add/Remove Programs)
```

See [INSTALLER.md](INSTALLER.md) for fleet rollout via GPO/Intune, upgrade
semantics, and the SmartScreen/code-signing gap.

## 8. Add Your First Check

1. Go to **Checks** in the Hub
2. Click **Add Check**
3. Select agent, check type (HTTP, Port, Service, etc.), and configure
4. The agent receives the check config automatically and starts monitoring

## 9. Configure Notifications

Go to **Settings → Notifications** and configure at least one channel:
- Microsoft Teams webhook
- Slack webhook
- Discord webhook
- Telegram bot
- Email (SMTP)

Test with the **Test** button on each channel.

## Done!

Your monitoring stack is live. Agents report every 60 seconds by default. Alerts fire on first failure, recover when check passes.

---

## Rebuild After Code Changes

```bash
cd vigil-hub
npx next build
systemctl --user restart vigil-hub
```

## View Logs

```bash
# Hub logs
tail -f /tmp/vigil-hub.log
journalctl --user -u vigil-hub -n 50

# Agent logs (Linux)
journalctl -u vigil-agent -f

# Agent logs (Windows)
Get-EventLog -LogName Application -Source VIGILAgent -Newest 20
```
