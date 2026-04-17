# Vigil — Self-Hosted Infrastructure Monitoring

A production-grade monitoring platform for IT teams. No SaaS, no subscriptions, no data leaving your network. Signed agent protocol, staged fleet updates, full admin console, system-tray UX on workstations.

## Components

| | |
|---|---|
| **vigil-hub** | Central dashboard (Next.js 16 + PostgreSQL + Better Auth). Receives agent data, verifies per-agent signatures, fires alerts, renders the admin console. |
| **vigil-agent** | Rust binary. Monitors services, ports, HTTP, ping, TLS certs, processes, logfiles, resources. Streams signed results to the Hub over WebSocket with SQLite buffering when offline. Exposes a local JSON-RPC IPC for `vigilctl` + the tray. |
| **vigil-tray** | Windows/Linux system-tray companion to the headless agent. Icon + menu + WebView HUD (WebView2 on Windows). Runs in the user session; the service stays in Session 0 per Windows platform rules. |

## Features

### Monitoring
- **Agent-side checks**: HTTP, TCP port, ping, systemd/SCM service, TLS certificate expiry, process name/count, logfile regex-tail with rotation detection, Windows event log, resource utilisation (CPU/RAM/disk/load/net).
- **Hub-side checks**: TLS certificate monitors on remote hosts, generic expiry monitors (Azure App Secrets, SAML certs, API keys).
- **Continuous telemetry**: every agent pushes a resource sample every 10s; Hub renders 24h sparklines on the Overview page.
- **Full hardware inventory** collected on each agent register (kernel, CPU, RAM, disks, NICs, container runtime, boot time).

### Alerting
- Fan-out to Slack, Microsoft Teams, Discord, Telegram, PagerDuty, Twilio SMS, SMTP email, generic webhook. Each delivery logged in the `NotificationDelivery` table ("why didn't Slack fire?" is one click).
- Incident model with firing / acknowledged / resolved states, postmortem markdown, MTTR tracking.
- Alerts fire on first failure, resolve on recovery. No alert storms — one notification per incident.
- `/api/admin/integrations/[kind]/test` sends a synthetic event without triggering the real dispatcher.

### Supply-chain & security
- **Signed check results**: every agent generates an ed25519 keypair on first run, sends its pubkey at registration; Hub pins it. Subsequent results are signed over canonical JSON and verified server-side. Tampered payloads are dropped and audited.
- **Signed agent releases**: operator-held ed25519 key signs every binary before upload. Agents verify against a pubkey baked in at compile time (`VIGIL_UPDATE_PUBKEY`). Rollouts refuse unsigned or mismatched releases.
- **Staged rollouts**: `/admin/rollouts` supports canary-first batches with configurable delay and auto-pause on failure. Update orchestrator runs in `server.ts`.
- **TLS**: agent verifies Hub certificate by default (`--insecure-skip-verify` opt-in for dev/self-signed).
- **SSRF-blocking**: Hub routes handling user-provided URLs (cert monitor, webhook test) refuse RFC1918/loopback/link-local unless `VIGIL_ALLOW_INTERNAL_NET=1`.
- **MFA/TOTP** via Better Auth, with backup codes, trust-this-device-30d, and admin reset.
- **Personal API tokens** per user (read/write/admin scopes, one-time plaintext reveal, argon2 hashed).
- **Audit log** writes for every mutating API route; CSV/JSON export from `/admin/audit`.
- **Agent enrollment tokens** use a CSPRNG; 15-minute TTL; single-use.

### Admin surface
- **Overview** — KPIs, top-offending checks, live incident feed, fleet strip, expiry radar.
- **Monitors** — unified table+grid for Check/Cert/Expiry with 5-step create wizard, status timeline, latency histogram, silence picker, runbook.
- **Profile** — name/avatar/timezone/locale, password, MFA enroll with QR + backup codes, active sessions (revoke), API tokens, notification preferences.
- **Admin → Users** — invite, role change, force sign-out, disable. Last-admin guards.
- **Admin → Audit** — full audit log with filters + CSV/JSON export.
- **Admin → Integrations** — one card per channel with edit / test / recent-deliveries.
- **Admin → System** — process/event-loop/DB/queue/job metrics + run-now buttons + diagnostics zip export.
- **Admin → Agent Releases** — upload binary, sign, activate per `(os, arch)`, per-release drift card.
- **Admin → Rollouts** — create + pause/resume/cancel staged rollouts.

### Power-user UX
- **⌘K command palette** — fuzzy search across agents / monitors / incidents + action items + `g`-prefix shortcuts.
- **🔔 notifications tray** — live SSE feed with unread badge, mute-1h, mark-all-read.
- **Dark mode** via `next-themes`; honours system preference.
- **Responsive**: tablet is first-class; mobile is read-only functional.

### Tray companion (v0.3.0-dev)
- Tray icon next to the clock with status-colored badge (green/amber/red/gray).
- Right-click menu: status line, Open Dashboard, Run Doctor, Run-check-now submenu, Silence submenu (15m/1h/4h), Pause-all (1h/4h), first-run enroll wizard, Quit Tray.
- Compact HUD window (WebView2 on Windows, webkit2gtk on Linux) with live Monitors / Resources / Events / Diagnostics tabs.
- Autostart on Windows login via HKCU Run; Linux via `~/.config/autostart/`.
- First-run wizard shells out to `vigil-agent --enroll` so non-technical users never touch PowerShell.
- Headless CLI is untouched — the tray is additive and optional.

### Operator tooling
- `vigil-agent doctor` — 11 preflight checks: config parse, DNS, TLS, clock skew, buffer writability, root-detection, CAP_NET_RAW, service registration, embedded pubkey fingerprint.
- `vigil-agent version --json` — machine-readable build/protocol/signing-fingerprint output.
- `vigilctl` — CLI into the running service via IPC: `status` / `list` / `run-now` / `silence` / `pause` / `tail-log [--follow]` / `reload` / `watch`.
- `scripts/sign-release.sh` — signs a binary with the operator's ed25519 private key; output fits the `/api/admin/agent-releases/[id]` PATCH body.
- `scripts/hub-watchdog.sh` + systemd timer — polls `/api/health` every minute and alerts Slack/Teams/Discord webhooks on Hub down/up transitions (with 2-failure debounce).

## Tech stack

| Component | Stack |
|---|---|
| Hub | Next.js 16.2.4, React 19, TypeScript, Tailwind 4, Prisma 6, PostgreSQL 16, Better Auth 1.5 (w/ 2FA plugin), TanStack Query + Table, `cmdk`, `next-themes`, Recharts, `archiver` |
| Agent | Rust (tokio, tokio-tungstenite, rustls, sysinfo, rusqlite, clap, ring ed25519, tracing) |
| Tray | Rust (`tray-icon`, `tao`, `wry` WebView2/webkit2gtk) |
| Auth | Better Auth (email/password, MFA/TOTP, OAuth Google+Microsoft optional) |
| DB | PostgreSQL (Hub), SQLite (agent event buffer) |
| IPC | JSON-RPC 2.0 over Unix socket (Linux) / Windows named pipe |

## Quick start

See [docs/QUICKSTART.md](./docs/QUICKSTART.md) for the full walk-through.

```bash
# 1. Postgres
docker run -d --name vigil-postgres \
  -e POSTGRES_DB=vigil -e POSTGRES_USER=vigil -e POSTGRES_PASSWORD=yourpass \
  -p 5433:5432 --restart unless-stopped postgres:16

# 2. Hub
cd vigil-hub
cp .env.example .env   # set DATABASE_URL, BETTER_AUTH_SECRET, ENCRYPTION_KEY (64 hex chars), NEXT_PUBLIC_APP_URL
npx prisma db push
npx next build

# 3. (optional but recommended) Generate the agent-update signing keypair
node --input-type=module -e '
  import { generateKeyPairSync, createHash } from "crypto";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPub = spki.subarray(spki.length - 32);
  console.log("pubkey hex:", rawPub.toString("hex"));
  console.log("fingerprint:", createHash("sha256").update(rawPub).digest("hex").slice(0,8));
  import("fs").then(fs => fs.writeFileSync(process.env.HOME + "/.config/vigil/update-signing-key.pem",
    privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }));
' # stash the pubkey hex, keep the private key offline / in a vault

# 4. Build agent + tray with the pubkey embedded
VIGIL_UPDATE_PUBKEY=<pubkey-hex> cargo build --manifest-path vigil-agent/Cargo.toml --release
VIGIL_UPDATE_PUBKEY=<pubkey-hex> cargo build --manifest-path vigil-agent/Cargo.toml --target x86_64-pc-windows-gnu --release
cargo build --manifest-path vigil-tray/Cargo.toml --target x86_64-pc-windows-gnu --release --features hud

# 5. Start the Hub
systemctl --user enable --now vigil-hub

# 6. Browser → http://YOUR_IP:3000 → complete setup wizard (creates admin account)

# 7. (optional) Enable the Hub watchdog so someone notices if the Hub itself dies
scripts/watchdog-install.sh

# 8. Enroll your first agent
# From the Hub UI: Agents → "Issue enrollment token"
sudo ./vigil-agent --enroll YOUR_TOKEN --hub-url http://YOUR_IP:3000
# Then approve the pending agent from the Hub's Agents page

# 9. (Windows workstations) copy vigil-tray.exe + WebView2Loader.dll next to
# the agent install; double-click → tray icon appears → first-run wizard if needed.
```

## Documentation

| Doc | Description |
|---|---|
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | Full deploy walk-through |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design + data flow |
| [docs/AGENT.md](./docs/AGENT.md) | Agent config, CLI flags, install |
| [docs/HUB.md](./docs/HUB.md) | Hub env vars, systemd, API reference |
| [docs/CHECKS.md](./docs/CHECKS.md) | Every monitor type — fields, behaviour, alert triggers |
| [docs/NOTIFICATIONS.md](./docs/NOTIFICATIONS.md) | Channels + custom payload templates |
| [docs/OAUTH.md](./docs/OAUTH.md) | Google + Microsoft OAuth setup |

## Development

```bash
# Hub in dev mode
cd vigil-hub && npm install && npx next dev

# Hub build + restart (needed for changes to server.ts / ws-server.ts / middleware.ts)
cd vigil-hub && npx next build && systemctl --user restart vigil-hub

# Native agent build (Linux)
cargo build --manifest-path vigil-agent/Cargo.toml --release

# Cross-compile agent for Windows
cargo build --manifest-path vigil-agent/Cargo.toml --target x86_64-pc-windows-gnu --release

# Tray cross-compile for Windows (WebView2Loader.dll auto-downloaded from NuGet)
cargo build --manifest-path vigil-tray/Cargo.toml --target x86_64-pc-windows-gnu --release --features hud

# Agent tests
cargo test --manifest-path vigil-agent/Cargo.toml

# Hub Playwright smokes
cd vigil-hub && npm run test:e2e

# Sign a release for the fleet
scripts/sign-release.sh target/release/vigil-agent
# → { sha256, signature, signedBy } — paste into the /admin/agent-releases PATCH body
```

## Architecture

```
                    ┌────────────────┐
                    │    Browser     │
                    └────────┬───────┘
                             │ HTTPS + SSE (typed events)
                             ▼
┌───────────────────────────────────────────────────┐
│               vigil-hub (Next.js 16)              │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐     │
│  │  Admin   │  │ Alerts + │  │  Rollouts    │     │
│  │ Console  │  │ Incidents│  │ Orchestrator │     │
│  └──────────┘  └──────────┘  └──────────────┘     │
│  ┌──────────┐  ┌──────────────────────────┐       │
│  │ Monitors │  │ Dispatcher (6 channels + │       │
│  │   UI     │  │  NotificationDelivery)   │       │
│  └──────────┘  └──────────────────────────┘       │
│                                                   │
│     Postgres      Cert/Expiry runners             │
└───────┬─────────────────────────────┬─────────────┘
        │                             │
        │ WebSocket (/ws/agent)       │ HTTPS /api/update/agent/*/version
        │ — signed payloads           │ — signed release metadata
        ▼                             ▼
┌───────────────────────────────────────────────────┐
│              vigil-agent (Rust)                   │
│                                                   │
│  Monitor loop  ─┐                                 │
│                 ├─► SQLite buffer ─► WS drain     │
│  Resource      ─┤                                 │
│  sampler       ─┘                                 │
│                                                   │
│  IPC server (unix socket / named pipe)            │
│    ▲                                              │
│    │ vigilctl (same binary)                       │
│    │ vigil-tray (Windows/Linux, user session)     │
└────┴──────────────────────────────────────────────┘
```

Key flows:

- **Check results**: agent monitor → agent SQLite buffer → drain on WS → Hub verifies ed25519 signature → stores check_result → processAlert → sendNotification (all 6 channels) + records NotificationDelivery row + broadcasts SSE event.
- **Remote actions**: Hub UI → `/api/monitors/check/[id]/run-now` → `sendAgentMessage` → agent WS handler → monitor runs on-demand → result back via buffer drain → `action_ack` back to Hub.
- **Agent update**: operator signs binary → uploads via `/admin/agent-releases` → activates → rollout-runner dispatches `update_now` to canary → agent verifies signature against embedded pubkey → swaps binary → reconnects reporting new version → rollout batches the rest.

Alerts fire on first failure, resolve automatically when check recovers. No alert storms — one notification per incident.

## Versions

- Hub: tracks `package.json`. Current: 0.1.0 (pinned to schema + UI; bumps are explicit).
- Agent: `Cargo.toml` of vigil-agent. Current: **0.3.0-dev** — ships IPC, vigilctl, signing, tray compatibility.
- Tray: ships alongside agent, matches version string.
- Wire protocol: `protocol_version = 2` in the register message.

## License

MIT
