import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

interface TopOffender {
  checkId: string;
  checkName: string;
  agentName: string;
  failureRate: number;
  totalResults: number;
  latencySparkline: number[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest): Promise<NextResponse<TopOffender[] | { error: string }>> {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const limit = Math.min(20, Math.max(1, parseInt(searchParams.get("limit") || "5", 10) || 5));
  const since = new Date(Date.now() - SEVEN_DAYS_MS);

  // Aggregate status counts per check over last 7d.
  const grouped = await db.checkResult.groupBy({
    by: ["checkId", "status"],
    where: { timestamp: { gte: since } },
    _count: { _all: true },
  });

  type Stat = { total: number; crit: number; warn: number };
  const byCheck = new Map<string, Stat>();
  for (const g of grouped) {
    const s = byCheck.get(g.checkId) ?? { total: 0, crit: 0, warn: 0 };
    s.total += g._count._all;
    if (g.status === "critical") s.crit += g._count._all;
    else if (g.status === "warning") s.warn += g._count._all;
    byCheck.set(g.checkId, s);
  }

  // Compute failure rate, rank, keep top N with >= 5 samples (avoid noise)
  const ranked: Array<{ checkId: string; failureRate: number; totalResults: number }> = [];
  for (const [checkId, s] of byCheck) {
    if (s.total < 5) continue;
    const failureRate = (s.crit + s.warn) / s.total;
    if (failureRate <= 0) continue;
    ranked.push({ checkId, failureRate, totalResults: s.total });
  }
  ranked.sort((a, b) => b.failureRate - a.failureRate);
  const top = ranked.slice(0, limit);

  if (top.length === 0) return NextResponse.json([]);

  // Pull check + agent names in one query
  const checkIds = top.map((t) => t.checkId);
  const checks = await db.check.findMany({
    where: { id: { in: checkIds } },
    select: {
      id: true,
      name: true,
      agent: { select: { name: true } },
    },
  });
  const checkLookup = new Map(checks.map((c) => [c.id, c]));

  // Latency sparkline (last 20 datapoints per check)
  const sparkMap = new Map<string, number[]>();
  for (const checkId of checkIds) {
    const rows = await db.checkResult.findMany({
      where: { checkId, timestamp: { gte: since } },
      select: { responseTimeMs: true, timestamp: true },
      orderBy: { timestamp: "desc" },
      take: 20,
    });
    // Reverse to chronological order, replace nulls with 0 for chart safety
    const spark = rows
      .map((r) => (typeof r.responseTimeMs === "number" ? r.responseTimeMs : 0))
      .reverse();
    sparkMap.set(checkId, spark);
  }

  const response: TopOffender[] = top.map((t) => {
    const c = checkLookup.get(t.checkId);
    return {
      checkId: t.checkId,
      checkName: c?.name ?? "(unknown)",
      agentName: c?.agent?.name ?? "(unknown)",
      failureRate: Number(t.failureRate.toFixed(4)),
      totalResults: t.totalResults,
      latencySparkline: sparkMap.get(t.checkId) ?? [],
    };
  });

  return NextResponse.json(response);
}
