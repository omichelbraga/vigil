import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";

async function getSession(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  return session;
}

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

  const where: Record<string, unknown> = {};
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
      _count: { select: { results: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(checks);
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

  const check = await db.check.create({
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

  return NextResponse.json(check, { status: 201 });
}
