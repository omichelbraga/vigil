# Hub image. Build context is the WORKSPACE ROOT (set in docker-compose.yml),
# not vigil-hub/. The repo is an npm workspace: package-lock.json lives at
# the root and vigil-hub is a workspace member, so the Hub can't be built
# from inside vigil-hub/ alone without losing dependency resolution.

# ===== deps stage =====
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vigil-hub/package.json ./vigil-hub/package.json
# All deps (incl. devDependencies). next build needs tailwindcss / typescript
# / etc. at build time, and the runner needs tsx at runtime to execute the
# custom server.ts. We rely on next.config.ts dropping standalone output —
# the runner copies the whole workspace, not a slimmed bundle.
RUN npm ci --workspace vigil-hub --include-workspace-root

# ===== builder stage =====
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/vigil-hub/node_modules ./vigil-hub/node_modules
COPY package.json package-lock.json ./
COPY vigil-hub ./vigil-hub
# Use vigil-hub's locally-pinned prisma 6.x — npx would resolve to the
# transitive 7.x hoisted at the workspace root, which can't parse our schema.
RUN cd vigil-hub && ./node_modules/.bin/prisma generate
# next build compiles the App Router output into vigil-hub/.next/. We don't
# use standalone output (see next.config.ts) because the project uses a
# custom server (vigil-hub/server.ts) that needs runtime access to lib/*
# modules the standalone tracer would drop.
RUN npm run build --workspace vigil-hub

# ===== runner stage =====
# Run server.ts directly via tsx — it owns the HTTP listener, mounts
# /ws/agent for agent WebSocket upgrades, and starts the cert/expiry/rollout
# background runners. Next.js handles HTTP routing through
# app.getRequestHandler().
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nextjs

# Copy the whole built workspace. Includes:
#   /app/node_modules/                ← workspace-root hoisted deps
#   /app/vigil-hub/node_modules/      ← member-pinned deps (prisma 6.x, ...)
#   /app/vigil-hub/.next/             ← compiled app
#   /app/vigil-hub/server.ts          ← entrypoint
#   /app/vigil-hub/lib/               ← ws-server, cert-monitor, ...
# Bigger image than standalone, but the only reliable shape that supports
# the custom server + traced symlinks (Prisma 6's hashed client) at once.
COPY --from=builder --chown=nextjs:nodejs /app /app

WORKDIR /app/vigil-hub
USER nextjs
EXPOSE 3000
# Bind to all interfaces (without HOSTNAME=0.0.0.0, Next picks the container
# hostname and the wget healthcheck / Docker NAT both fail with ECONNREFUSED).
ENV HOSTNAME=0.0.0.0
# 127.0.0.1 not localhost — Alpine resolves localhost to ::1 first; Node
# listens v4-only, wget never falls back from v6.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# Migrations run in the vigil-migrate sidecar (compose); by the time
# vigil-hub starts the schema is already in place. tsx is hoisted to the
# workspace root (/app/node_modules/.bin/tsx) by npm workspaces, so we
# invoke it from there.
CMD ["/app/node_modules/.bin/tsx", "server.ts"]
