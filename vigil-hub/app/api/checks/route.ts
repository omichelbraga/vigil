import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getConnectedAgentIds } from "@/lib/ws-server";
import { audit } from "@/lib/audit";



function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

const VALID_CHECK_TYPES = [
  "service",
  "port",
  "http",
  "ping",
  "cert",
  "process",
  "resource",
];

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agent_id");

  const where: Record<string, unknown> = {
    agent: { isActive: true },  // only show checks for active agents
  };
  if (agentId) {
    if (!isValidUUID(agentId)) {
      return NextResponse.json(
        { error: "Invalid agent_id format" },
        { status: 400 },
      );
    }
    where.agentId = agentId;
  }

  const checks = await db.check.findMany({
    where,
    select: {
      id: true,
      agentId: true,
      name: true,
      type: true,
      config: true,
      enabled: true,
      intervalSecs: true,
      createdAt: true,
      updatedAt: true,
      agent: {
        select: { id: true, name: true },
      },
      results: {
        orderBy: { timestamp: "desc" },
        take: 1,
        select: {
          status: true,
          responseTimeMs: true,
          timestamp: true,
          message: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Flatten latest result into each check — use snake_case to match UI expectations
  const checksWithStatus = checks.map((c) => {
    const latest = c.results[0] ?? null;
    return {
      id: c.id,
      agent_id: c.agentId,
      agent_name: c.agent?.name ?? null,
      name: c.name,
      type: c.type,
      config: c.config,
      enabled: c.enabled,
      interval_seconds: c.intervalSecs,
      created_at: c.createdAt,
      status: latest?.status ?? null,
      latency_ms: latest?.responseTimeMs ?? null,
      last_checked: latest?.timestamp ?? null,
      last_message: latest?.message ?? null,
    };
  });

  return NextResponse.json(checksWithStatus);
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Validate agentId
  if (!body.agentId || typeof body.agentId !== "string" || !isValidUUID(body.agentId)) {
    return NextResponse.json(
      { error: "Valid agentId is required" },
      { status: 400 },
    );
  }

  // Validate name
  if (
    !body.name ||
    typeof body.name !== "string" ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 200
  ) {
    return NextResponse.json(
      { error: "Name is required (1-200 chars)" },
      { status: 400 },
    );
  }

  // Validate type
  if (!body.type || !VALID_CHECK_TYPES.includes(body.type)) {
    return NextResponse.json(
      { error: `Type must be one of: ${VALID_CHECK_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  // Validate config
  if (!body.config || typeof body.config !== "object") {
    return NextResponse.json(
      { error: "Config must be a JSON object" },
      { status: 400 },
    );
  }

  // Validate intervalSecs
  const intervalSecs = body.intervalSecs ?? 30;
  if (
    typeof intervalSecs !== "number" ||
    !Number.isInteger(intervalSecs) ||
    intervalSecs < 5 ||
    intervalSecs > 86400
  ) {
    return NextResponse.json(
      { error: "intervalSecs must be an integer between 5 and 86400" },
      { status: 400 },
    );
  }

  // Verify agent exists and is active
  const agent = await db.agent.findUnique({
    where: { id: body.agentId, isActive: true },
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  let check;
  try {
    check = await db.check.create({
      data: {
        agentId: body.agentId,
        name: body.name.trim(),
        type: body.type,
        config: body.config,
        enabled: body.enabled ?? true,
        intervalSecs,
      },
      select: {
        id: true,
        agentId: true,
        name: true,
        type: true,
        config: true,
        enabled: true,
        intervalSecs: true,
        createdAt: true,
      },
    });
  } catch (err) {
    // Unique-constraint violation on (agent_id, name) — surface as 409, not 500.
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: `A check named "${body.name.trim()}" already exists on this agent` },
        { status: 409 },
      );
    }
    throw err;
  }

  // Push new check to agent if currently connected
  const connected = global._vigilAgents as Map<string, { ws: { send: (d: string) => void }, agentId: string }> | undefined;
  if (connected?.has(body.agentId)) {
    connected.get(body.agentId)!.ws.send(JSON.stringify({
      type: "configure_checks",
      checks: [{
        id: check.id,
        name: check.name,
        type: check.type,
        config: check.config,
        interval_seconds: check.intervalSecs,
      }],
    }));
  }

  await audit(req, session.user.id, "check.create", {
    entityType: "check",
    entityId: check.id,
    metadata: { name: check.name, type: check.type, agentId: check.agentId },
  });

  return NextResponse.json(check, { status: 201 });
}
