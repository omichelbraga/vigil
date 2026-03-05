# Vigil Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         VIGIL HUB                               │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Next.js    │  │  WebSocket   │  │   Alert Engine       │   │
│  │  Dashboard  │  │  Server      │  │   (fire-once/resolve)│   │
│  │  (port 3000)│  │  (/ws/agent) │  │                      │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                │                      │               │
│  ┌──────▼──────────────────────────────────────▼───────────┐   │
│  │                    PostgreSQL                            │   │
│  │  agents | checks | check_results | alert_history |      │   │
│  │  alert_channels | cert_monitors | expiry_monitors | ... │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────┐   │
│  │ Cert Monitor │  │ Expiry Monitor│  │  SSE Broadcaster   │   │
│  │ (hourly)     │  │ (every 6h)    │  │  (push to browser) │   │
│  └──────────────┘  └───────────────┘  └────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         ▲ WebSocket                           ▲ HTTP (SSE)
         │                                     │
┌────────┴────────┐                   ┌────────┴────────┐
│  VIGIL AGENT    │                   │    BROWSER      │
│  (Linux/Win)    │                   │  Dashboard UI   │
│                 │                   └─────────────────┘
│ ┌─────────────┐ │
│ │  Monitors   │ │     Notifications:
│ │ - HTTP      │ │     ┌──────────┐ ┌─────────┐ ┌────────┐
│ │ - Port      │ │────►│  Teams   │ │  Slack  │ │Discord │
│ │ - Ping      │ │     └──────────┘ └─────────┘ └────────┘
│ │ - Service   │ │     ┌──────────┐ ┌─────────┐ ┌────────┐
│ │ - Cert (TLS)│ │────►│ Telegram │ │  Email  │ │Webhook │
│ │ - Resource  │ │     └──────────┘ └─────────┘ └────────┘
│ └─────────────┘ │
│ ┌─────────────┐ │
│ │ SQLite      │ │
│ │ event buffer│ │
│ └─────────────┘ │
└─────────────────┘
```

## Data Flow

### Check Result Flow
```
Agent monitors → check() → MonitorResult
  → serialize as JSON
  → push to SQLite event buffer
  → hub_client sends via WebSocket
  → Hub ws-server receives check_result
  → match to DB check record (exact name / stripped prefix / config.name)
  → insert CheckResult row
  → processAlert() → fire or resolve incident
  → broadcast via SSE to all browser tabs
  → browser updates status badge in real-time
```

### Agent Enrollment Flow
```
Admin generates token → DB enrollment_tokens table
vigil-agent --enroll TOKEN --hub-url URL
  → POST /api/enroll { token, agentName, hostname }
  → Hub validates token, creates agent record (isActive: false)
  → Admin approves in Hub → isActive: true
  → Agent connects WebSocket → 403 while pending, 200 when approved
  → Hub sends configure_checks → agent starts running Hub-defined checks
```

### Alert Flow
```
processAlert(ctx) called with { checkId, status, message, ... }
  → status critical/warning + no open incident
    → create AlertHistory record (status: "fired")
    → sendNotification() → all enabled channels in parallel
  → status ok + open incident exists
    → update AlertHistory (status: "resolved")
    → sendNotification() (unless skipRecovery: true)
  → status ok + no open incident → silent (no action)
```

### Agent Offline Flow
```
WebSocket closes → agents Map removes agent
  → insert unknown CheckResult for all agent checks
  → sendAgentOfflineAlert() → all channels
  → SSE broadcasts agent_status offline → browser flips badge

WebSocket reconnects → agents Map adds agent
  → lastSeen > 90s ago → sendAgentOnlineAlert() → all channels
  → SSE broadcasts agent_status online
```

## Hub Components

| Component | File | Description |
|-----------|------|-------------|
| HTTP+WS Server | `server.ts` | Custom Node HTTP server wrapping Next.js + WebSocket |
| WebSocket Handler | `lib/ws-server.ts` | Agent auth, message routing, SSE broadcasting |
| Alert Engine | `lib/alert-engine.ts` | Fire-once alerts, recovery notifications, channel dispatch |
| Cert Monitor | `lib/cert-monitor.ts` | TLS cert checks, runs hourly via scheduler |
| Session Auth | `lib/session.ts` | DB-backed session lookup (strips HMAC suffix) |
| DB Client | `lib/db.ts` | Prisma client singleton |
| Status Utils | `lib/status.ts` | Consistent status label and color helpers |

## Agent Components

| Component | File | Description |
|-----------|------|-------------|
| Main Loop | `src/main.rs` | Config loading, monitor setup, async event loop |
| Hub Client | `src/hub_client.rs` | WebSocket reconnect loop, check_result sender, configure_checks handler |
| Event Buffer | `src/buffer.rs` | SQLite-backed event queue for offline buffering |
| Monitors | `src/monitors/` | HTTP, Port, Ping, Service, Cert, Resource |
| Enrollment | `src/enroll.rs` | One-shot enrollment HTTP call |
| Installer | `src/installer.rs` | Linux systemd + Windows SCM service install |
| Windows Service | `src/windows_service.rs` | SCM integration via `windows-service` crate |

## Security Design

- Agent tokens: argon2id hashed in DB, never stored in plaintext
- Session cookies: HttpOnly, SameSite=Strict, HMAC-signed by Better Auth
- WebSocket auth: Bearer token validated against argon2 hash on every connect
- Enrollment tokens: one-time use, expire after 6 hours
- Passwords: argon2id via Better Auth
- Credentials at rest: AES-256-GCM encryption (SMTP password)
- No raw SQL: all queries via Prisma parameterized
- CORS: locked to Hub origin
- PostgreSQL: not exposed outside Docker network
