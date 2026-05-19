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
# Strict reproducible install of production deps for the Hub workspace.
# --include-workspace-root brings in any deps declared on the root package
# (currently none at runtime, but future-proof).
RUN npm ci --omit=dev --workspace vigil-hub --include-workspace-root

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
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nextjs

# Next.js standalone bundle. Standalone preserves the workspace structure,
# so the runnable server is at vigil-hub/.next/standalone/vigil-hub/.
COPY --from=builder /app/vigil-hub/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/.next/standalone/vigil-hub/ ./
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/.next/standalone/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/.next/static ./.next/static
COPY --from=builder /app/vigil-hub/prisma ./prisma

# Bundle the prisma CLI so the entrypoint can apply the schema on startup.
# Pull from vigil-hub/node_modules — NOT the workspace root — because the
# Hub pins prisma@6.x while a transitive 7.x is hoisted at the root. The
# matching version of @prisma/client is also under vigil-hub/node_modules
# (same workspace-pin reason), so we copy both from there for consistency.
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/vigil-hub/node_modules/.bin/prisma ./node_modules/.bin/prisma

USER nextjs
EXPOSE 3000
# start-period covers prisma db push on a cold DB.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
# Apply schema before starting the server. Idempotent on an already-current
# schema; refuses destructive changes without --accept-data-loss.
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && node server.js"]
