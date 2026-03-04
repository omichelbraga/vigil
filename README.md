# Vigil — Server Monitoring Platform

Production-grade server monitoring with a Rust agent and Next.js hub.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        vigil-hub                                │
│                   (Next.js 15 / App Router)                     │
│                                                                 │
│  ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌────────────────┐  │
│  │ Dashboard  │ │ Alert    │ │ Cert       │ │ Azure KeyVault │  │
│  │ Web UI    │ │ Engine   │ │ Monitor    │ │ Monitor        │  │
│  └───────────┘ └──────────┘ └────────────┘ └────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              WebSocket Server (wss://)                    │  │
│  └─────────────────────┬─────────────────────────────────────┘  │
│                        │                                        │
│  ┌─────────────────────┴─────────────────────────────────────┐  │
│  │              PostgreSQL (via Prisma)                       │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ wss:// + token auth + TLS pinning
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
   │  Agent  │         │  Agent  │         │  Agent  │
   │ (Rust)  │         │ (Rust)  │         │ (Rust)  │
   │         │         │         │         │         │
   │ Monitors│         │ Monitors│         │ Monitors│
   │ ┌─────┐ │         │ ┌─────┐ │         │ ┌─────┐ │
   │ │SQLite│ │         │ │SQLite│ │         │ │SQLite│ │
   │ └─────┘ │         │ └─────┘ │         │ └─────┘ │
   └─────────┘         └─────────┘         └─────────┘
    Server A             Server B            Server C
```

## Components

### vigil-agent (Rust)
- Deployed on Linux/Windows servers
- Monitors: services, ports, HTTP, ping, processes, resources, SSL certs
- Local SQLite buffer when Hub is unreachable
- Connects to Hub via wss:// with token auth + TLS cert pinning
- Self-updates from Hub

### vigil-hub (Next.js 15)
- Central dashboard receiving real-time data from agents
- Web UI, admin portal, alert engine
- Certificate monitoring, Azure Key Vault monitoring
- Agent update distribution
- PostgreSQL via Prisma

## Security Model

- All secrets via environment variables — never in code
- `.env` never committed; `.env.example` always present
- All database access via Prisma ORM — no raw SQL
- Agent tokens stored as argon2 hashes — never plaintext
- Security headers on every response (HSTS, CSP, X-Frame-Options, etc.)
- HttpOnly + Secure + SameSite=Strict cookies only
- Input validation on every API route
- Secrets and tokens are never logged

## Quick Start

### Prerequisites
- Rust 1.75+ with Cargo
- Node.js 20+ with npm
- PostgreSQL 15+

### Development

```bash
# Clone
git clone https://github.com/your-org/vigil.git
cd vigil

# Agent
cd vigil-agent
cp config.example.toml config.toml  # edit as needed
cargo run -- --hub-url wss://localhost:3000 --hub-token YOUR_TOKEN

# Hub
cd vigil-hub
cp .env.example .env  # edit with your database URL and secrets
npm install
npx prisma migrate dev
npm run dev
```

### Build for Production

```bash
# Agent
cd vigil-agent
cargo build --release

# Hub
cd vigil-hub
npm run build
npm start
```

## Project Structure

```
vigil/
├── Cargo.toml              # Rust workspace
├── package.json             # Node workspace
├── vigil-agent/             # Rust monitoring agent
│   ├── Cargo.toml
│   ├── config.example.toml
│   └── src/
│       ├── main.rs
│       ├── config.rs
│       ├── hub_client.rs
│       ├── buffer.rs
│       └── monitors/
│           ├── mod.rs
│           ├── service.rs
│           ├── port.rs
│           ├── http.rs
│           ├── ping.rs
│           └── cert.rs
└── vigil-hub/               # Next.js hub application
    ├── prisma/schema.prisma
    ├── app/
    │   └── api/health/route.ts
    └── middleware.ts
```

## License

Proprietary — All rights reserved.
