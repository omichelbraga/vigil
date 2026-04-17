import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import type { MonitorKind } from "@/lib/monitors";

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

const VALID_KINDS: readonly MonitorKind[] = ["check", "cert", "expiry"];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
): Promise<NextResponse> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const { kind, id } = await params;
  if (!(VALID_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }
  if (!isUUID(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  if (kind === "check") {
    const check = await db.check.findUnique({
      where: { id },
      include: {
        agent: { select: { id: true, name: true } },
      },
    });
    if (!check) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [results, histogramResults] = await Promise.all([
      db.checkResult.findMany({
        where: { checkId: id },
        orderBy: { timestamp: "desc" },
        take: 50,
        select: {
          id: true,
          status: true,
          message: true,
          responseTimeMs: true,
          timestamp: true,
        },
      }),
      db.checkResult.findMany({
        where: { checkId: id, responseTimeMs: { not: null } },
        orderBy: { timestamp: "desc" },
        take: 1000,
        select: { responseTimeMs: true, status: true, timestamp: true },
      }),
    ]);

    const silenced = !!(check.silencedUntil && check.silencedUntil.getTime() > Date.now());
    const latestRaw = results[0]?.status ?? null;
    const status = silenced ? "silenced" : latestRaw ?? "unknown";
    return NextResponse.json({
      kind: "check" as const,
      id: check.id,
      name: check.name,
      type: check.type,
      config: check.config,
      enabled: check.enabled,
      intervalSecs: check.intervalSecs,
      slo: check.slo,
      runbookMarkdown: check.runbookMarkdown,
      silencedUntil: check.silencedUntil?.toISOString() ?? null,
      agent: check.agent,
      status,
      createdAt: check.createdAt.toISOString(),
      updatedAt: check.updatedAt.toISOString(),
      recentResults: results.map((r) => ({
        id: r.id,
        status: r.status,
        message: r.message,
        responseTimeMs: r.responseTimeMs,
        timestamp: r.timestamp.toISOString(),
      })),
      histogram: histogramResults
        .filter((r): r is typeof r & { responseTimeMs: number } => r.responseTimeMs !== null)
        .map((r) => ({
          responseTimeMs: r.responseTimeMs,
          status: r.status,
          timestamp: r.timestamp.toISOString(),
        })),
    });
  }

  if (kind === "cert") {
    const cert = await db.certMonitor.findUnique({ where: { id } });
    if (!cert) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({
      kind: "cert" as const,
      id: cert.id,
      name: cert.host,
      type: "cert",
      config: { host: cert.host, port: cert.port, warn_days: cert.warnDays },
      enabled: cert.enabled,
      intervalSecs: null,
      slo: null,
      runbookMarkdown: null,
      silencedUntil: null,
      agent: null,
      expiresAt: cert.expiresAt?.toISOString() ?? null,
      issuer: cert.issuer,
      lastChecked: cert.lastChecked?.toISOString() ?? null,
      status: cert.status,
      createdAt: cert.createdAt.toISOString(),
      updatedAt: cert.updatedAt.toISOString(),
      recentResults: [],
      histogram: [],
    });
  }

  // expiry
  const exp = await db.expiryMonitor.findUnique({ where: { id } });
  if (!exp) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    kind: "expiry" as const,
    id: exp.id,
    name: exp.name,
    type: "expiry",
    config: {
      name: exp.name,
      description: exp.description,
      category: exp.category,
      expires_at: exp.expiresAt.toISOString(),
      warn_days: exp.warnDays,
    },
    enabled: true,
    intervalSecs: null,
    slo: null,
    runbookMarkdown: null,
    silencedUntil: null,
    agent: null,
    expiresAt: exp.expiresAt.toISOString(),
    category: exp.category,
    description: exp.description,
    lastChecked: exp.lastChecked?.toISOString() ?? null,
    createdAt: exp.createdAt.toISOString(),
    updatedAt: exp.updatedAt.toISOString(),
    recentResults: [],
    histogram: [],
  });
}
