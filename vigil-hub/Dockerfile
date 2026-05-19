FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nextjs

# Copy standalone output — workspace structure nests under vigil-hub/
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone/vigil-hub/ ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma

# Bundle the prisma CLI so the entrypoint can apply the schema on startup.
# Next.js's standalone tracer only follows runtime imports (@prisma/client),
# so the CLI binary + its engines need to be copied explicitly from the
# builder stage. Without this, the container has no way to materialise the
# schema on a fresh Postgres and the Hub crashes on first request with
# "relation \"agents\" does not exist".
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

USER nextjs
EXPOSE 3000
# start-period bumped to 60s to cover prisma db push on cold DB.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
# Apply schema before starting the server. `prisma db push --skip-generate`
# is idempotent against an already-current schema and exits 0; if it detects
# a destructive change it errors out without --accept-data-loss, which is
# the right safety default for production. Add --accept-data-loss to CMD
# only when knowingly running a destructive migration.
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && node server.js"]
