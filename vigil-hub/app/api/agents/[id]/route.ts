import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  const agent = await db.agent.findUnique({
    where: { id, isActive: true },
    select: {
      id: true,
      name: true,
      lastSeen: true,
      version: true,
      os: true,
      hostname: true,
      ipAddress: true,
      isActive: true,
      autoUpdate: true,
      createdAt: true,
      updatedAt: true,
      checks: {
        where: { enabled: true },
        select: {
          id: true,
          name: true,
          type: true,
          config: true,
          enabled: true,
          intervalSecs: true,
          createdAt: true,
        },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const recentResults = await db.checkResult.findMany({
    where: { agentId: id },
    select: {
      id: true,
      checkId: true,
      status: true,
      message: true,
      responseTimeMs: true,
      metadata: true,
      timestamp: true,
    },
    orderBy: { timestamp: "desc" },
    take: 50,
  });

  const now = new Date();
  const status =
    agent.lastSeen && now.getTime() - agent.lastSeen.getTime() < 120_000
      ? "online"
      : "offline";

  // Build a map of latest result per check
  const latestByCheck = new Map<string, typeof recentResults[0]>();
  for (const r of recentResults) {
    if (!latestByCheck.has(r.checkId)) latestByCheck.set(r.checkId, r);
  }

  // Enrich checks with latest status/latency — use snake_case for UI
  const enrichedChecks = agent.checks.map((c) => {
    const latest = latestByCheck.get(c.id) ?? null;
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      config: c.config,
      enabled: c.enabled,
      interval_seconds: c.intervalSecs,
      status: latest?.status ?? null,
      latency_ms: latest?.responseTimeMs ?? null,
      last_checked: latest?.timestamp ?? null,
      last_message: latest?.message ?? null,
    };
  });

  // Build check name lookup
  const checkNameMap = new Map(agent.checks.map((c) => [c.id, c.name]));

  // Normalize recentResults to snake_case for UI
  const normalizedResults = recentResults.map((r) => ({
    id: r.id,
    check_name: checkNameMap.get(r.checkId) ?? r.checkId,
    status: r.status,
    latency_ms: r.responseTimeMs ?? null,
    created_at: r.timestamp,
    message: r.message ?? null,
    metadata: r.metadata ?? null,
  }));

  return NextResponse.json({
    ...agent,
    last_seen: agent.lastSeen,
    ip_address: agent.ipAddress,
    checks: enrichedChecks,
    status,
    recentResults: normalizedResults,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 100) {
      return NextResponse.json(
        { error: "Name must be 1-100 characters" },
        { status: 400 },
      );
    }
    const name = body.name.trim();
    const existing = await db.agent.findFirst({
      where: { name, id: { not: id } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Agent name already exists" },
        { status: 409 },
      );
    }
    data.name = name;
  }

  if (body.autoUpdate !== undefined) {
    if (typeof body.autoUpdate !== "boolean") {
      return NextResponse.json(
        { error: "autoUpdate must be a boolean" },
        { status: 400 },
      );
    }
    data.autoUpdate = body.autoUpdate;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  const agent = await db.agent.findUnique({ where: { id, isActive: true } });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const updated = await db.agent.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      autoUpdate: true,
      updatedAt: true,
    },
  });

  await audit(req, auth.user.id, "agent.update", {
    entityType: "agent",
    entityId: id,
    metadata: { changedFields: Object.keys(data) },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  const agent = await db.agent.findUnique({ where: { id, isActive: true } });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Hard delete — cascade removes checks, results, alert history
  await db.check.deleteMany({ where: { agentId: id } });
  await db.checkResult.deleteMany({ where: { agentId: id } });
  await db.alertHistory.deleteMany({ where: { agentId: id } });
  await db.agent.delete({ where: { id } });

  await audit(req, auth.user.id, "agent.delete", {
    entityType: "agent",
    entityId: id,
    metadata: { name: agent.name },
  });

  return NextResponse.json({ message: "Agent deleted" });
}
