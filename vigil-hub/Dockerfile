# Hub image. Build context is the WORKSPACE ROOT (set in docker-compose.yml),
# not vigil-hub/. The repo is an npm workspace: package-lock.json lives at
# the root and vigil-hub is a workspace member, so the Hub can't be built
# from inside vigil-hub/ alone without losing dependency resolution.

# ===== deps stage =====
FROM node:20-alpine AS deps
WORKDIR /app
# Workspace root manifest + lockfile, plus the Hub's own manifest. We don't
# pull the Rust crates (vigil-agent, vigil-tray) — they aren't in the npm
# workspace and aren't needed for the Hub image.
COPY package.json package-lock.json ./
COPY vigil-hub/package.json ./vigil-hub/package.json
# Strict reproducible install of ALL deps for the Hub workspace, including
# devDependencies. Build-time tooling (tailwindcss, @tailwindcss/postcss,
# typescript, eslint-config-next, …) lives under devDependencies and is
# required to compile the app — `next build` invokes the PostCSS pipeline
# which needs @tailwindcss/postcss installed. Pruning happens implicitly:
# the runner stage copies only Next.js's standalone bundle, which is
# self-trimmed (Vercel's tracer keeps only the runtime closure).
RUN npm ci --workspace vigil-hub --include-workspace-root

# ===== builder stage =====
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/vigil-hub/node_modules ./vigil-hub/node_modules
COPY package.json package-lock.json ./
COPY vigil-hub ./vigil-hub
# Generate Prisma client (needs to happen after the schema is in place).
# Use vigil-hub's locally-installed prisma binary explicitly: the workspace
# root has a transitive prisma@7.x hoisted next to it, and `npx prisma`
# from inside vigil-hub/ resolves to that one first, which can't parse
# inline `url = env(...)` and silently produces a stale client.
RUN cd vigil-hub && ./node_modules/.bin/prisma generate
# Build Next.js standalone for the vigil-hub workspace.
RUN npm run build --workspace vigil-hub

# ===== runner stage =====
FROM node:20-alpine AS runner
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nextjs

# Preserve Next.js's standalone layout intact. The standalone bundle is
# already shaped for direct execution:
#   /app/node_modules/                   ← hoisted workspace-root deps
#   /app/vigil-hub/server.js             ← entrypoint
#   /app/vigil-hub/.next/...             ← compiled code + symlinks that
#                                          point at ../../../../vigil-hub/
#                                          node_modules/@prisma/client
#   /app/vigil-hub/node_modules/...      ← member deps; @prisma/client lives
#                                          here and the satellite symlink
#                                          resolves to it
# Flattening this layout (the previous approach) broke the Prisma 6 hash-
# suffixed client symlink — `Cannot find module @prisma/client-<hash>`.
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/.next/standalone /app
# public/ and .next/static are not part of the standalone trace.
COPY --from=builder /app/vigil-hub/public /app/vigil-hub/public
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/.next/static /app/vigil-hub/.next/static
# Prisma schema kept alongside the runnable bundle for diagnostics.
COPY --from=builder /app/vigil-hub/prisma /app/vigil-hub/prisma

WORKDIR /app/vigil-hub
USER nextjs
EXPOSE 3000
# Bind Next.js's standalone server to all interfaces. Without this it picks
# the container's own hostname (e.g. "5015036523f2") and only listens on
# that interface — both the HEALTHCHECK (wget http://localhost:3000) and
# Docker's NAT port-forward (0.0.0.0 → container) fail with ECONNREFUSED.
ENV HOSTNAME=0.0.0.0
# Use 127.0.0.1 explicitly: `localhost` in Alpine resolves to ::1 first and
# Node's listen(0.0.0.0) is IPv4-only, so wget gets ECONNREFUSED on the v6
# attempt before falling back. Pinning to v4 makes the healthcheck reliable.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# Migrations run in a separate one-shot sidecar service (see docker-compose
# `vigil-migrate`), which uses this Dockerfile's `builder` stage and has the
# full prisma CLI dependency graph (including hoisted transitives like
# `effect`). Once that exits 0, vigil-hub starts and trusts the schema.
CMD ["node", "server.js"]
