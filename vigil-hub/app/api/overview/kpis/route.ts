import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getConnectedAgentIds } from "@/lib/ws-server";

interface KpiResponse {
  agentsOnline: number;
  agentsTotal: number;
  agentsOnlineSparkline: number[];
  openIncidents: number;
  incidentsTrendHourly: number[];
  uptimePct7d: number;
  mttrSeconds7d: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

export async function GET(req: NextRequest): Promise<NextResponse<KpiResponse | { error: string }>> {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const since7d = new Date(now.getTime() - SEVEN_DAYS_MS);
  const since24h = new Date(now.getTime() - DAY_MS);

  // Agents total + currently connected (via WS map)
  const [agents, connectedSet] = await Promise.all([
    db.agent.findMany({
      where: { isActive: true, NOT: { tokenHash: "hub-internal" } },
      select: { id: true, lastSeen: true },
    }),
    Promise.resolve(getConnectedAgentIds()),
  ]);

  const agentsTotal = agents.length;
  const agentsOnline = agents.filter((a) => connectedSet.has(a.id)).length;

  // 24h agents-online sparkline — bucket ResourceSample distinct agents per hour
  // Fallback: derive from Agent.lastSeen if no samples exist.
  const samplesForSpark = await db.resourceSample.findMany({
    where: { timestamp: { gte: since24h } },
    select: { agentId: true, timestamp: true },
    take: 50_000,
    orderBy: { timestamp: "asc" },
  });

  const hourBucketsOnline: Set<string>[] = Array.from({ length: 24 }, () => new Set<string>());
  for (const s of samplesForSpark) {
    const hoursAgo = Math.floor((now.getTime() - s.timestamp.getTime()) / HOUR_MS);
    const idx = 23 - hoursAgo;
    if (idx >= 0 && idx < 24) hourBucketsOnline[idx].add(s.agentId);
  }
  let agentsOnlineSparkline: number[] = hourBucketsOnline.map((set) => set.size);
  // If the spark is all zeros (no resource pushes wired yet), fill with current online count
  let nonZero = false;
  for (const v of agentsOnlineSparkline) {
    if (v !== 0) { nonZero = true; break; }
  }
  if (!nonZero) {
    agentsOnlineSparkline = Array.from({ length: 24 }, () => agentsOnline);
  }

  // Open incidents + 24h trend per hour.
  // Prefer the new Incident table; fall back to AlertHistory when empty so the
  // page stays useful before the alert-engine has been rewired to emit incidents.
  const [incidentRowCount, openIncidentRows, incidents24h] = await Promise.all([
    db.incident.count(),
    db.incident.count({ where: { status: "firing" } }),
    db.incident.findMany({
      where: { firedAt: { gte: since24h } },
      select: { firedAt: true },
      take: 5_000,
      orderBy: { firedAt: "asc" },
    }),
  ]);

  let openIncidents = openIncidentRows;
  const incidentsTrendHourly = new Array<number>(24).fill(0);

  if (incidentRowCount > 0) {
    for (const i of incidents24h) {
      const hoursAgo = Math.floor((now.getTime() - i.firedAt.getTime()) / HOUR_MS);
      const idx = 23 - hoursAgo;
      if (idx >= 0 && idx < 24) incidentsTrendHourly[idx] += 1;
    }
  } else {
    // Fallback: use AlertHistory. "firing" == status === "fired" with no resolvedAt.
    const [firingAlerts, alerts24h] = await Promise.all([
      db.alertHistory.count({ where: { status: "fired", resolvedAt: null } }),
      db.alertHistory.findMany({
        where: { firedAt: { gte: since24h } },
        select: { firedAt: true },
        take: 5_000,
        orderBy: { firedAt: "asc" },
      }),
    ]);
    openIncidents = firingAlerts;
    for (const a of alerts24h) {
      const hoursAgo = Math.floor((now.getTime() - a.firedAt.getTime()) / HOUR_MS);
      const idx = 23 - hoursAgo;
      if (idx >= 0 && idx < 24) incidentsTrendHourly[idx] += 1;
    }
  }

  // Uptime 7d: share of OK results over (OK + warning + critical). Unknown excluded.
  const results7d = await db.checkResult.groupBy({
    by: ["status"],
    where: { timestamp: { gte: since7d } },
    _count: { _all: true },
  });
  let ok = 0;
  let measured = 0;
  for (const r of results7d) {
    const c = r._count._all;
    if (r.status === "ok") {
      ok += c;
      measured += c;
    } else if (r.status === "warning" || r.status === "critical") {
      measured += c;
    }
  }
  const uptimePct7d = measured > 0 ? (ok / measured) * 100 : 100;

  // MTTR 7d from resolved incidents — fall back to AlertHistory if empty.
  let mttrSeconds7d = 0;
  const computeMttr = (rows: Array<{ firedAt: Date; resolvedAt: Date | null }>): number => {
    let totalMs = 0;
    let n = 0;
    for (const r of rows) {
      if (!r.resolvedAt) continue;
      const dur = r.resolvedAt.getTime() - r.firedAt.getTime();
      if (dur >= 0) {
        totalMs += dur;
        n += 1;
      }
    }
    return n > 0 ? Math.round(totalMs / n / 1000) : 0;
  };

  if (incidentRowCount > 0) {
    const resolved7d = await db.incident.findMany({
      where: {
        status: "resolved",
        resolvedAt: { not: null, gte: since7d },
      },
      select: { firedAt: true, resolvedAt: true },
      take: 1_000,
    });
    mttrSeconds7d = computeMttr(resolved7d);
  } else {
    const resolvedAlerts7d = await db.alertHistory.findMany({
      where: {
        status: "resolved",
        resolvedAt: { not: null, gte: since7d },
      },
      select: { firedAt: true, resolvedAt: true },
      take: 1_000,
    });
    mttrSeconds7d = computeMttr(resolvedAlerts7d);
  }

  const payload: KpiResponse = {
    agentsOnline,
    agentsTotal,
    agentsOnlineSparkline,
    openIncidents,
    incidentsTrendHourly,
    uptimePct7d: Number.isFinite(uptimePct7d) ? Number(uptimePct7d.toFixed(2)) : 100,
    mttrSeconds7d,
  };

  return NextResponse.json(payload);
}
