# Vigil Hub Reference

## Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | ✅ | 32-byte hex secret for Better Auth |
| `BETTER_AUTH_URL` | ✅ | Public URL of the Hub (used for OAuth callbacks) |
| `ENCRYPTION_KEY` | ✅ | 32-byte hex key for AES-256-GCM credential encryption |
| `NODE_ENV` | ✅ | Set to `production` for deployment |

**Generate secrets:**
```bash
openssl rand -hex 32   # Use once for BETTER_AUTH_SECRET, once for ENCRYPTION_KEY
```

## Build & Deploy

```bash
# 1. Install dependencies
cd vigil-hub && npm install

# 2. Sync database schema
npx prisma db push

# 3. Build production bundle
npx next build

# 4. Start/restart service
systemctl --user restart vigil-hub
```

> **Important:** After every code change, you must rebuild (`npx next build`) and restart the service.

## systemd Service

File: `~/.config/systemd/user/vigil-hub.service`

```ini
[Unit]
Description=Vigil Hub - Server Monitoring Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/michelbragaguimaraes/Documents/Projects/vigil/vigil-hub
ExecStart=/home/linuxbrew/.linuxbrew/bin/node /home/linuxbrew/.linuxbrew/lib/node_modules/tsx/dist/cli.mjs server.ts
Environment=NODE_ENV=production
Restart=always
RestartSec=5
StandardOutput=append:/tmp/vigil-hub.log
StandardError=append:/tmp/vigil-hub.log

[Install]
WantedBy=default.target
```

**Reload after editing service file:**
```bash
systemctl --user daemon-reload
systemctl --user restart vigil-hub
```

## Logs

```bash
# Tail application log
tail -f /tmp/vigil-hub.log

# Systemd journal
journalctl --user -u vigil-hub -n 50 -f

# Check service status
systemctl --user status vigil-hub
```

## Health Check

```bash
curl http://localhost:3000/api/health
# {"status":"ok"}
```

## API Routes (Summary)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/agents` | List active agents with live status |
| DELETE | `/api/agents/:id` | Hard delete agent + all associated data |
| GET | `/api/checks` | List checks (active agents only) |
| POST | `/api/checks` | Create check + push to connected agent |
| PUT | `/api/checks/:id` | Update check name/interval |
| DELETE | `/api/checks/:id` | Delete check + results |
| GET | `/api/certs` | List cert monitors |
| POST | `/api/certs` | Add cert monitor + immediate check |
| DELETE | `/api/certs/:id` | Delete cert monitor |
| GET | `/api/expiry-monitors` | List expiry monitors |
| POST | `/api/expiry-monitors` | Create expiry monitor |
| PUT | `/api/expiry-monitors/:id` | Update expiry monitor |
| DELETE | `/api/expiry-monitors/:id` | Delete expiry monitor |
| POST | `/api/expiry-monitors/check` | Run all expiry checks now |
| GET | `/api/alerts` | Alert history |
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update settings |
| POST | `/api/settings/test` | Test notification channel |
| GET | `/api/enrollment` | Generate enrollment token |
| POST | `/api/enroll` | Agent enrollment endpoint |
| GET | `/api/sse` | Server-Sent Events stream |

## WebSocket Protocol

Endpoint: `/ws/agent`

**Auth:** `Authorization: Bearer <agent_token>` header on upgrade request.

### Hub → Agent messages

```json
// Push configured checks to agent
{
  "type": "configure_checks",
  "checks": [
    {
      "id": "uuid",
      "name": "Print Spooler",
      "type": "service",
      "config": { "name": "Spooler" },
      "interval_seconds": 60
    }
  ]
}
```

### Agent → Hub messages

```json
// Check result
{
  "type": "check_result",
  "check_name": "service:Spooler",
  "status": "ok",
  "latency_ms": 12,
  "message": "Service running",
  "checked_at": "2026-03-05T08:00:00Z",
  "metadata": {}
}

// Heartbeat (every 30s)
{
  "type": "heartbeat"
}
```

## next.config.ts Settings

```typescript
{
  output: "standalone",
  serverExternalPackages: ["argon2"],
  allowedDevOrigins: ["192.168.9.113"],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true }
}
```

## Database (PostgreSQL)

```bash
# Connect
docker exec -it vigil-postgres psql -U vigil -d vigil

# Useful queries
SELECT name, is_active, last_seen FROM agents;
SELECT name, type, status FROM checks;
SELECT * FROM alert_history WHERE status = 'fired' ORDER BY fired_at DESC;
SELECT * FROM expiry_monitors ORDER BY expires_at;
```
