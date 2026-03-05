# Vigil — Self-Hosted Server Monitoring

A production-grade monitoring platform for IT teams. No SaaS, no subscriptions, no data leaving your network.

## Components

| | |
|---|---|
| **vigil-hub** | Central dashboard (Next.js + PostgreSQL). Receives agent data, fires alerts, hosts the web UI. |
| **vigil-agent** | Lightweight Rust binary. Runs on any Linux or Windows server. Executes checks, streams results over WebSocket. |

## Features

- **Multi-agent support** — monitor unlimited servers from one Hub
- **Check types** — HTTP, Port, Ping, Service (systemctl/SCM), TLS Certificate, Resource (CPU/RAM/Disk), Expiry Date
- **Real-time dashboard** — live status updates via Server-Sent Events (no refresh needed)
- **Alert channels** — Microsoft Teams, Slack, Discord, Telegram, Email (SMTP), Generic Webhook
- **Custom notification payloads** — full template system with `{{variables}}`
- **Agent offline detection** — immediate alert when agent disconnects, recovery when it reconnects
- **Enrollment tokens** — one-command agent onboarding (`--enroll TOKEN --hub-url URL`)
- **Expiry Monitors** — track Azure App Secrets, SAML certificates, API keys (Hub-side, no agent needed)
- **Certificate monitoring** — TLS cert expiry alerts (warning at N days, critical when expired, silent when OK)
- **Windows service support** — auto-install as SCM service with restart-on-failure
- **MFA/TOTP** — enforced for admin accounts via Better Auth

## Tech Stack

| Component | Tech |
|-----------|------|
| Hub | Next.js 15, TypeScript, Prisma, PostgreSQL, Better Auth, Tailwind CSS |
| Agent | Rust (tokio, tokio-tungstenite, rustls, sysinfo, rusqlite, clap) |
| Auth | Better Auth (email/password, MFA/TOTP) |
| Database | PostgreSQL (Hub), SQLite (Agent event buffer) |

## Quick Start

See [docs/QUICKSTART.md](./docs/QUICKSTART.md) for full setup instructions.

```bash
# 1. Start PostgreSQL
docker run -d --name vigil-postgres \
  -e POSTGRES_DB=vigil -e POSTGRES_USER=vigil -e POSTGRES_PASSWORD=yourpass \
  -p 5433:5432 --restart unless-stopped postgres:16

# 2. Configure Hub
cd vigil-hub
cp .env.example .env   # Edit with your DB URL, secrets, Hub URL
npx prisma db push
npx next build

# 3. Start Hub
systemctl --user start vigil-hub

# 4. Open browser → http://YOUR_IP:3000 → complete setup wizard

# 5. Enroll an agent
sudo ./vigil-agent --enroll YOUR_TOKEN --hub-url http://YOUR_IP:3000
# Approve in Hub → Agents page
```

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | Deploy from scratch in 15 minutes |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design, data flow, component overview |
| [docs/AGENT.md](./docs/AGENT.md) | Agent config reference, CLI flags, Linux/Windows install |
| [docs/HUB.md](./docs/HUB.md) | Hub environment variables, systemd, API reference |
| [docs/CHECKS.md](./docs/CHECKS.md) | All check types — fields, behavior, alert triggers |
| [docs/NOTIFICATIONS.md](./docs/NOTIFICATIONS.md) | Notification channels, custom payload templates |
| [docs/OAUTH.md](./docs/OAUTH.md) | Google and Microsoft OAuth setup |

## Screenshots

_Dashboard, Checks, Expiry Monitors, and Notification Settings_

## Development

```bash
# Hub (dev mode — requires rebuild for ws-server.ts changes)
cd vigil-hub && npm install && npx next dev

# Agent
cd vigil-agent && cargo build

# Cross-compile agent for Windows
cargo build --target x86_64-pc-windows-gnu --release

# Rebuild Hub after changes
cd vigil-hub && npx next build && systemctl --user restart vigil-hub
```

## Architecture

```
Browser ←─SSE─── Hub ───WS──→ Agent (Linux/Windows)
               │                    │
          PostgreSQL           Local checks
          Alert Engine         SQLite buffer
          Cert Monitor
          Expiry Monitor
```

Alerts fire on first failure, resolve automatically when check recovers. No alert storms — one notification per incident.

## License

MIT
