# Vigil Documentation

Vigil is a self-hosted, production-grade server monitoring platform built for IT teams that need full control over their monitoring stack — no SaaS subscriptions, no data leaving the network.

## Components

| Component | Description |
|-----------|-------------|
| **vigil-hub** | Central dashboard (Next.js + PostgreSQL). Receives agent data, displays dashboards, fires alerts. |
| **vigil-agent** | Lightweight Rust binary. Runs on monitored servers. Executes checks, streams results to Hub. |

## Documentation Index

| Doc | Description |
|-----|-------------|
| [QUICKSTART.md](./QUICKSTART.md) | Deploy Vigil from scratch in 15 minutes |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, data flow, component overview |
| [AGENT.md](./AGENT.md) | Agent config reference, CLI flags, Linux/Windows install |
| [HUB.md](./HUB.md) | Hub environment variables, systemd setup, build process |
| [CHECKS.md](./CHECKS.md) | All check types — fields, behavior, alert triggers |
| [NOTIFICATIONS.md](./NOTIFICATIONS.md) | Notification channels, custom payload templates |
| [OAUTH.md](./OAUTH.md) | Google and Microsoft OAuth configuration |

## Quick Links

- **Hub URL**: `http://<your-server>:3000`
- **Agent enrollment**: Run `vigil-agent --enroll <TOKEN> --hub-url <URL>` on any server
- **Logs**: `journalctl --user -u vigil-hub -f` (Hub) | `journalctl -u vigil-agent -f` (Agent)
- **Restart Hub**: `systemctl --user restart vigil-hub`
- **Rebuild Hub**: `cd ~/Documents/Projects/vigil/vigil-hub && npx next build && systemctl --user restart vigil-hub`
