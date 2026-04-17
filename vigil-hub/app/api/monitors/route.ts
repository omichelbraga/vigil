import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import type {
  MonitorKind,
  MonitorListResponse,
  MonitorStatus,
  MonitorSummary,
  MonitorType,
} from "@/lib/monitors";
import { CHECK_MONITOR_TYPES } from "@/lib/monitors";

type CheckConfig = Record<string, unknown>;

function strProp(cfg: CheckConfig | null | undefined, key: string): string {
  const v = cfg?.[key];
  return typeof v === "string" ? v : "";
}

function numProp(cfg: CheckConfig | null | undefined, key: string): number | null {
  const v = cfg?.[key];
  return typeof v === "number" ? v : null;
}

function renderCheckTarget(type: string, cfg: CheckConfig | null | undefined): string {
  switch (type) {
    case "http": {
      return strProp(cfg, "url") || "(no url)";
    }
    case "port": {
      const host = strProp(cfg, "host");
      const port = numProp(cfg, "port");
      return host ? `${host}:${port ?? "?"}` : "(no host)";
    }
    case "ping": {
      return strProp(cfg, "host") || strProp(cfg, "target") || "(no host)";
    }
    case "service": {
      return strProp(cfg, "name") || strProp(cfg, "service_name") || "(no service)";
    }
    case "cert": {
      const host = strProp(cfg, "host");
      const port = numProp(cfg, "port") ?? 443;
      return host ? `${host}:${port}` : "(no host)";
    }
    case "resource": {
      return "CPU / RAM / Disk";
    }
    case "process": {
      return strProp(cfg, "process_name") || strProp(cfg, "name") || "(no process)";
    }
    case "logfile": {
      return strProp(cfg, "path") || "(no path)";
    }
    case "event_log": {
      const ch = strProp(cfg, "channel");
      const id = numProp(cfg, "event_id");
      return ch ? (id != null ? `${ch} / id=${id}` : ch) : "(no channel)";
    }
    default:
      return type;
  }
}

function certStatus(status: string | null | undefined, expiresAt: Date | null): MonitorStatus {
  if (status === "expired" || status === "critical") return "critical";
  if (status === "expiring" || status === "warning") return "warning";
  if (status === "valid" || status === "ok") return "ok";
  if (expiresAt) {
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    if (days <= 0) return "critical";
    if (days <= 30) return "warning";
    return "ok";
  }
  return "unknown";
}

function expiryStatus(expiresAt: Date, warnDays: number): MonitorStatus {
  const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
  if (days <= 0) return "critical";
  if (days <= warnDays) return "warning";
  return "ok";
}

function mapCheckStatus(
  raw: string | null,
  silencedUntil: Date | null,
): MonitorStatus {
  if (silencedUntil && silencedUntil.getTime() > Date.now()) return "silenced";
  switch (raw) {
    case "ok":
      return "ok";
    case "warning":
    case "warn":
      return "warning";
    case "critical":
    case "offline":
      return "critical";
    case "unknown":
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

/** Build a 24-bucket hourly-average latency sparkline from recent results. */
function sparklineFromResults(
  results: { timestamp: Date; responseTimeMs: number | null }[],
): number[] {
  const now = Date.now();
  const buckets: { sum: number; count: number }[] = Array.from({ length: 24 }, () => ({
    sum: 0,
    count: 0,
  }));
  for (const r of results) {
    if (r.responseTimeMs == null) continue;
    const ageMs = now - r.timestamp.getTime();
    const hourIdx = Math.floor(ageMs / 3_600_000);
    if (hourIdx < 0 || hourIdx >= 24) continue;
    // reverse so index 0 is oldest, 23 is most-recent
    const idx = 23 - hourIdx;
    buckets[idx].sum += r.responseTimeMs;
    buckets[idx].count += 1;
  }
  return buckets.map((b) => (b.count === 0 ? 0 : Math.round(b.sum / b.count)));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const typeParam = searchParams.get("type");
  const agentParam = searchParams.get("agent");
  const statusParam = searchParams.get("status");
  const searchParamStr = searchParams.get("search")?.trim().toLowerCase() ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const perPageRaw = parseInt(searchParams.get("per_page") ?? "50", 10) || 50;
  const perPage = Math.min(200, Math.max(1, perPageRaw));

  const wantTypes: Set<string> | null =
    typeParam && typeParam !== "all"
      ? new Set(typeParam.split(",").map((s) => s.trim()).filter(Boolean))
      : null;

  // ── Checks (optionally narrowed by agent / type) ────────────
  const checkWhere: Record<string, unknown> = {
    agent: { isActive: true },
  };
  if (agentParam) checkWhere.agentId = agentParam;
  if (wantTypes) {
    const checkTypes = [...wantTypes].filter((t) => (CHECK_MONITOR_TYPES as readonly string[]).includes(t));
    if (checkTypes.length === 0 && !wantTypes.has("cert") && !wantTypes.has("expiry")) {
      // user selected no check-compatible types; skip checks entirely
      checkWhere.id = "__never__";
    } else if (checkTypes.length > 0) {
      checkWhere.type = { in: checkTypes };
    } else {
      checkWhere.id = "__never__";
    }
  }

  const sinceWindow = new Date(Date.now() - 24 * 3_600_000);

  const [checks, certs, expiries] = await Promise.all([
    db.check.findMany({
      where: checkWhere,
      select: {
        id: true,
        agentId: true,
        name: true,
        type: true,
        config: true,
        intervalSecs: true,
        slo: true,
        runbookMarkdown: true,
        silencedUntil: true,
        createdAt: true,
        agent: { select: { id: true, name: true } },
        results: {
          orderBy: { timestamp: "desc" },
          take: 1,
          select: { status: true, timestamp: true, responseTimeMs: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    wantTypes && !wantTypes.has("cert") && wantTypes.size > 0
      ? Promise.resolve([])
      : agentParam
        ? Promise.resolve([])
        : db.certMonitor.findMany({ orderBy: { createdAt: "desc" } }),
    wantTypes && !wantTypes.has("expiry") && wantTypes.size > 0
      ? Promise.resolve([])
      : agentParam
        ? Promise.resolve([])
        : db.expiryMonitor.findMany({ orderBy: { expiresAt: "asc" } }),
  ]);

  // Fetch sparkline results for every check in one batch.
  const checkIds = checks.map((c) => c.id);
  const sparklineData =
    checkIds.length > 0
      ? await db.checkResult.findMany({
          where: { checkId: { in: checkIds }, timestamp: { gte: sinceWindow } },
          select: { checkId: true, timestamp: true, responseTimeMs: true },
        })
      : [];
  const byCheck = new Map<string, { timestamp: Date; responseTimeMs: number | null }[]>();
  for (const r of sparklineData) {
    const arr = byCheck.get(r.checkId) ?? [];
    arr.push({ timestamp: r.timestamp, responseTimeMs: r.responseTimeMs });
    byCheck.set(r.checkId, arr);
  }

  const items: MonitorSummary[] = [];

  const nowMs = Date.now();
  const computeStale = (lastMs: number | null, intervalSecs: number | null): boolean => {
    if (lastMs == null || intervalSecs == null) return false;
    return nowMs - lastMs > intervalSecs * 3_000; // 3× interval in ms
  };

  for (const c of checks) {
    const latest = c.results[0];
    const cfg = (c.config ?? {}) as CheckConfig;
    const status = mapCheckStatus(latest?.status ?? null, c.silencedUntil);
    const spark = sparklineFromResults(byCheck.get(c.id) ?? []);
    const typeAsMonitor = (CHECK_MONITOR_TYPES as readonly string[]).includes(c.type)
      ? (c.type as MonitorType)
      : ("http" as MonitorType);
    const lastMs = latest?.timestamp ? latest.timestamp.getTime() : null;
    items.push({
      id: c.id,
      kind: "check",
      name: c.name,
      type: typeAsMonitor,
      target: renderCheckTarget(c.type, cfg),
      agentId: c.agentId,
      agentName: c.agent?.name ?? null,
      intervalSecs: c.intervalSecs,
      status,
      latencySparkline: spark,
      slo: c.slo ?? null,
      lastResultAt: lastMs ? new Date(lastMs).toISOString() : null,
      isStale: computeStale(lastMs, c.intervalSecs),
      silencedUntil: c.silencedUntil ? c.silencedUntil.toISOString() : null,
      runbookMarkdown: c.runbookMarkdown ?? null,
    });
  }

  for (const cert of certs) {
    const status = certStatus(cert.status, cert.expiresAt);
    items.push({
      id: cert.id,
      kind: "cert",
      name: cert.host,
      type: "cert",
      target: `${cert.host}:${cert.port}`,
      agentId: null,
      agentName: null,
      intervalSecs: null,
      status,
      latencySparkline: [],
      slo: null,
      lastResultAt: cert.lastChecked ? cert.lastChecked.toISOString() : null,
      isStale: false,
      silencedUntil: null,
      runbookMarkdown: null,
    });
  }

  for (const exp of expiries) {
    const status = expiryStatus(exp.expiresAt, exp.warnDays);
    items.push({
      id: exp.id,
      kind: "expiry",
      name: exp.name,
      type: "expiry",
      target: exp.category,
      agentId: null,
      agentName: null,
      intervalSecs: null,
      status,
      latencySparkline: [],
      slo: null,
      lastResultAt: exp.lastChecked ? exp.lastChecked.toISOString() : null,
      isStale: false,
      silencedUntil: null,
      runbookMarkdown: null,
    });
  }

  // ── Post-filtering (status + search + pagination) ──────────
  let filtered = items;
  if (statusParam && statusParam !== "all") {
    filtered = filtered.filter((i) => i.status === statusParam);
  }
  if (searchParamStr.length > 0) {
    filtered = filtered.filter((i) => {
      const hay = `${i.name} ${i.target} ${i.agentName ?? ""}`.toLowerCase();
      return hay.includes(searchParamStr);
    });
  }

  const total = filtered.length;
  const start = (page - 1) * perPage;
  const paged = filtered.slice(start, start + perPage);

  const body: MonitorListResponse = {
    items: paged,
    total,
    page,
    perPage,
  };
  return NextResponse.json(body);
}

// Used elsewhere when importing kinds
export type { MonitorKind };
