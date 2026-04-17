import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export interface IncidentRow {
  id: string;
  source: "incident" | "alert";
  agentId: string | null;
  agentName: string | null;
  checkId: string | null;
  checkName: string | null;
  severity: "warning" | "critical";
  status: "firing" | "acknowledged" | "resolved";
  title: string;
  firedAt: string;
  resolvedAt: string | null;
}

const VALID_STATUS = new Set(["firing", "acknowledged", "resolved", "all"]);

export async function GET(req: NextRequest): Promise<NextResponse<IncidentRow[] | { error: string }>> {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status") || "firing";
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "10", 10) || 10));

  if (!VALID_STATUS.has(statusParam)) {
    return NextResponse.json({ error: `Invalid status: ${statusParam}` }, { status: 400 });
  }

  const incidentWhere = statusParam === "all" ? {} : { status: statusParam };

  const incidents = await db.incident.findMany({
    where: incidentWhere,
    orderBy: { firedAt: "desc" },
    take: limit,
    select: {
      id: true,
      agentId: true,
      checkId: true,
      severity: true,
      status: true,
      title: true,
      firedAt: true,
      resolvedAt: true,
      agent: { select: { name: true } },
      check: { select: { name: true } },
    },
  });

  // If we have real incidents, return them.
  if (incidents.length > 0) {
    const rows: IncidentRow[] = incidents.map((i) => ({
      id: i.id,
      source: "incident",
      agentId: i.agentId,
      agentName: i.agent?.name ?? null,
      checkId: i.checkId,
      checkName: i.check?.name ?? null,
      severity: (i.severity === "critical" ? "critical" : "warning") as "warning" | "critical",
      status: (["firing", "acknowledged", "resolved"].includes(i.status) ? i.status : "firing") as
        | "firing"
        | "acknowledged"
        | "resolved",
      title: i.title,
      firedAt: i.firedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
    }));
    return NextResponse.json(rows);
  }

  // Fallback: derive pseudo-incidents from AlertHistory.
  // Strategy: for each (checkId OR ruleId+agentId) group, find the most recent
  // "fired" entry. If a later "resolved"/"acknowledged" exists, reflect that.
  const alerts = await db.alertHistory.findMany({
    where: {
      status: statusParam === "all" ? undefined : statusParam === "firing" ? "fired" : statusParam,
    },
    orderBy: { firedAt: "desc" },
    take: limit * 4, // oversample, dedupe below
    select: {
      id: true,
      ruleId: true,
      checkId: true,
      agentId: true,
      status: true,
      message: true,
      firedAt: true,
      resolvedAt: true,
      rule: { select: { name: true } },
    },
  });

  // Dedupe: one row per (checkId || ruleId+agentId)
  const seen = new Set<string>();
  const dedup: typeof alerts = [];
  for (const a of alerts) {
    const key = a.checkId ?? `${a.ruleId}:${a.agentId ?? "unknown"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(a);
    if (dedup.length >= limit) break;
  }

  const agentIds = Array.from(
    new Set(dedup.map((a) => a.agentId).filter((x): x is string => typeof x === "string")),
  );
  const checkIds = Array.from(
    new Set(dedup.map((a) => a.checkId).filter((x): x is string => typeof x === "string")),
  );

  const [agentMap, checkMap] = await Promise.all([
    agentIds.length > 0
      ? db.agent
          .findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
          .then((list) => new Map(list.map((a) => [a.id, a.name])))
      : Promise.resolve(new Map<string, string>()),
    checkIds.length > 0
      ? db.check
          .findMany({ where: { id: { in: checkIds } }, select: { id: true, name: true } })
          .then((list) => new Map(list.map((c) => [c.id, c.name])))
      : Promise.resolve(new Map<string, string>()),
  ]);

  const rows: IncidentRow[] = dedup.map((a) => {
    const status: IncidentRow["status"] =
      a.status === "resolved"
        ? "resolved"
        : a.status === "acknowledged"
          ? "acknowledged"
          : "firing";
    // Severity is not stored on AlertHistory — infer "critical" by default
    const severity: IncidentRow["severity"] = "critical";
    return {
      id: a.id,
      source: "alert",
      agentId: a.agentId ?? null,
      agentName: a.agentId ? (agentMap.get(a.agentId) ?? null) : null,
      checkId: a.checkId ?? null,
      checkName: a.checkId ? (checkMap.get(a.checkId) ?? null) : null,
      severity,
      status,
      title: a.rule?.name ?? a.message ?? "Alert fired",
      firedAt: a.firedAt.toISOString(),
      resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
    };
  });

  return NextResponse.json(rows);
}
