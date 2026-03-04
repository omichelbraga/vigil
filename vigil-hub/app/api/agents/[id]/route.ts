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

  return NextResponse.json({ ...agent, status, recentResults });
}

export async function PATCH(
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

  return NextResponse.json(updated);
}

export async function DELETE(
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

  const agent = await db.agent.findUnique({ where: { id, isActive: true } });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  await db.agent.update({
    where: { id },
    data: { isActive: false },
  });

  return NextResponse.json({ message: "Agent deactivated" });
}
