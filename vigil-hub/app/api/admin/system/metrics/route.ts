import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import {
  getEventLoopHistogram,
  getJobLastRun,
  getSchemaDigest,
  setSchemaDigest,
} from "@/lib/system-metrics";

// Keep this handler on the Node runtime — perf_hooks + fs are not available on edge.
export const runtime = "nodejs";

// ── Types ───────────────────────────────────────────────────────────────

interface ProcessBlock {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  uptimeSecs: number;
  nodeVersion: string;
  platform: string;
  pid: number;
}

interface EventLoopBlock {
  meanMs: number;
  maxMs: number;
  p99Ms: number;
  sampleCount: number;
}

interface ConnectionsBlock {
  websocketAgents: number;
  sseClients: number;
  recentlyDisconnectedCount: number;
  connectedAgentNames: string[];
}

interface DatabaseBlock {
  reachable: boolean;
  latencyMs: number | null;
  totalAgents: number;
  totalChecks: number;
  totalResults24h: number;
  totalIncidents: number;
  totalUsers: number;
}

interface QueuesBlock {
  notificationDeliveriesPending: number;
  notificationDeliveriesFailed1h: number;
  notificationDeliveriesRetrying: number;
}

interface JobStatus {
  lastRunAt: string | null;
  nextRunEstimateAt: string;
  intervalMins: number;
}

interface JobsBlock {
  certMonitor: JobStatus;
  expiryMonitor: JobStatus;
}

interface VersionsBlock {
  hubVersion: string;
  hubBuildSha: string;
  schemaDigest: string;
  agentVersionHistogram: Record<string, number>;
}

interface SigningBlock {
  agentUpdatePubkeyFingerprint: string | null;
  resultSigningPinnedAgents: number;
}

export interface SystemMetrics {
  process: ProcessBlock;
  eventLoop: EventLoopBlock;
  connections: ConnectionsBlock;
  database: DatabaseBlock;
  queues: QueuesBlock;
  jobs: JobsBlock;
  versions: VersionsBlock;
  signing: SigningBlock;
}

// ── Module-level caches (one per process) ───────────────────────────────

let cachedHubVersion: string | null = null;

function readHubVersion(): string {
  if (cachedHubVersion) return cachedHubVersion;
  // Inlined env var is the fast path during next build; fall back to reading
  // package.json if that's unset (dev with `next dev` + custom server).
  const fromEnv = process.env.npm_package_version;
  if (fromEnv && fromEnv.length > 0) {
    cachedHubVersion = fromEnv;
    return cachedHubVersion;
  }
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      cachedHubVersion = (parsed as { version: string }).version;
      return cachedHubVersion;
    }
  } catch {
    /* fall through */
  }
  cachedHubVersion = "0.0.0";
  return cachedHubVersion;
}

async function computeSchemaDigest(): Promise<string> {
  const cached = getSchemaDigest();
  if (cached) return cached;
  try {
    // Pull every (table, column) pair in the public schema and hash a sorted
    // deterministic rendering. Good enough to detect drift without being a
    // DDL parser.
    const rows = await db.$queryRaw<
      Array<{ table_name: string; column_name: string }>
    >(Prisma.sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name
    `);
    const serialized = rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .sort()
      .join("\n");
    const digest = createHash("sha256").update(serialized).digest("hex");
    setSchemaDigest(digest);
    return digest;
  } catch {
    // DB unreachable or pg_catalog query failed — don't throw.
    return "unknown";
  }
}

// ── Global accessors (written by ws-server.ts) ──────────────────────────

interface ConnectedAgentLike {
  agentId: string;
  agentName: string;
}

function readConnectedAgents(): ConnectedAgentLike[] {
  const g = globalThis as { _vigilAgents?: Map<string, ConnectedAgentLike> };
  if (!g._vigilAgents) return [];
  return Array.from(g._vigilAgents.values()).map((a) => ({
    agentId: a.agentId,
    agentName: a.agentName,
  }));
}

function readSseClientCount(): number {
  const g = globalThis as { _vigilSseClients?: Set<unknown> };
  return g._vigilSseClients ? g._vigilSseClients.size : 0;
}

function readRecentlyDisconnectedCount(): number {
  const g = globalThis as { _vigilRecentlyDisconnected?: Set<unknown> };
  return g._vigilRecentlyDisconnected ? g._vigilRecentlyDisconnected.size : 0;
}

// ── Database snapshot ───────────────────────────────────────────────────

interface DbSnapshot {
  database: DatabaseBlock;
  queues: QueuesBlock;
  agentVersionHistogram: Record<string, number>;
  resultSigningPinnedAgents: number;
}

async function snapshotDatabase(): Promise<DbSnapshot> {
  const startedAt = Date.now();
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since1h = new Date(Date.now() - 60 * 60 * 1000);

    // Cheap round-trip to confirm DB reachability + measure latency.
    await db.$queryRaw(Prisma.sql`SELECT 1`);
    const latencyMs = Date.now() - startedAt;

    const [
      totalAgents,
      totalChecks,
      totalResults24h,
      totalIncidents,
      totalUsers,
      failed1h,
      retrying,
      versionGroups,
      resultSigningPinnedAgents,
    ] = await Promise.all([
      db.agent.count(),
      db.check.count(),
      db.checkResult.count({ where: { timestamp: { gte: since24h } } }),
      db.incident.count(),
      db.user.count(),
      db.notificationDelivery.count({
        where: { status: "failed", sentAt: { gte: since1h } },
      }),
      db.notificationDelivery.count({ where: { status: "retrying" } }),
      db.agent.groupBy({
        by: ["version"],
        _count: { _all: true },
      }),
      db.agent.count({
        where: { isActive: true, resultSigningPubkey: { not: null } },
      }),
    ]);

    const agentVersionHistogram: Record<string, number> = {};
    for (const row of versionGroups) {
      const key = row.version && row.version.length > 0 ? row.version : "unknown";
      agentVersionHistogram[key] = row._count._all;
    }

    return {
      database: {
        reachable: true,
        latencyMs,
        totalAgents,
        totalChecks,
        totalResults24h,
        totalIncidents,
        totalUsers,
      },
      queues: {
        // "Pending" has no dedicated status — deliveries row is only written
        // after an attempt. Retrying is the closest proxy for "still in
        // flight". Failed-in-last-hour surfaces recent breakage.
        notificationDeliveriesPending: retrying,
        notificationDeliveriesFailed1h: failed1h,
        notificationDeliveriesRetrying: retrying,
      },
      agentVersionHistogram,
      resultSigningPinnedAgents,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[admin/system/metrics] DB snapshot failed:", err);
    return {
      database: {
        reachable: false,
        latencyMs: null,
        totalAgents: 0,
        totalChecks: 0,
        totalResults24h: 0,
        totalIncidents: 0,
        totalUsers: 0,
      },
      queues: {
        notificationDeliveriesPending: 0,
        notificationDeliveriesFailed1h: 0,
        notificationDeliveriesRetrying: 0,
      },
      agentVersionHistogram: {},
      resultSigningPinnedAgents: 0,
    };
  }
}

// ── Job schedule ────────────────────────────────────────────────────────

const CERT_INTERVAL_MINS = 60;
const EXPIRY_INTERVAL_MINS = 360;

function jobStatus(
  name: "cert" | "expiry",
  intervalMins: number,
): JobStatus {
  const last = getJobLastRun(name);
  const nextMs = (last ? last.getTime() : Date.now()) + intervalMins * 60_000;
  return {
    lastRunAt: last ? last.toISOString() : null,
    nextRunEstimateAt: new Date(nextMs).toISOString(),
    intervalMins,
  };
}

// ── Event-loop snapshot ─────────────────────────────────────────────────

function snapshotEventLoop(): EventLoopBlock {
  const h = getEventLoopHistogram();
  // Nanoseconds → milliseconds for display. `percentile` expects 0-100.
  const meanMs = h.mean / 1e6;
  const maxMs = h.max / 1e6;
  const p99Ms = h.percentile(99) / 1e6;
  // `count` is a bigint on older node — normalise.
  const rawCount = (h as { count?: number | bigint }).count;
  const sampleCount =
    typeof rawCount === "bigint" ? Number(rawCount) : Number(rawCount ?? 0);
  // Reset so the next poll measures a fresh window.
  h.reset();
  return {
    meanMs: Number.isFinite(meanMs) ? Number(meanMs.toFixed(3)) : 0,
    maxMs: Number.isFinite(maxMs) ? Number(maxMs.toFixed(3)) : 0,
    p99Ms: Number.isFinite(p99Ms) ? Number(p99Ms.toFixed(3)) : 0,
    sampleCount,
  };
}

// ── Route handler ───────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const connected = readConnectedAgents();
  const mem = process.memoryUsage();

  const [dbSnap, schemaDigest] = await Promise.all([
    snapshotDatabase(),
    computeSchemaDigest(),
  ]);

  const payload: SystemMetrics = {
    process: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      uptimeSecs: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
    },
    eventLoop: snapshotEventLoop(),
    connections: {
      websocketAgents: connected.length,
      sseClients: readSseClientCount(),
      recentlyDisconnectedCount: readRecentlyDisconnectedCount(),
      connectedAgentNames: connected
        .map((c) => c.agentName)
        .sort((a, b) => a.localeCompare(b)),
    },
    database: dbSnap.database,
    queues: dbSnap.queues,
    jobs: {
      certMonitor: jobStatus("cert", CERT_INTERVAL_MINS),
      expiryMonitor: jobStatus("expiry", EXPIRY_INTERVAL_MINS),
    },
    versions: {
      hubVersion: readHubVersion(),
      hubBuildSha: process.env.GIT_SHA && process.env.GIT_SHA.length > 0
        ? process.env.GIT_SHA
        : "unknown",
      schemaDigest,
      agentVersionHistogram: dbSnap.agentVersionHistogram,
    },
    signing: {
      // P6.4 wires these up; until then, nothing is pinned.
      agentUpdatePubkeyFingerprint: null,
      resultSigningPinnedAgents: dbSnap.resultSigningPinnedAgents,
    },
  };

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
