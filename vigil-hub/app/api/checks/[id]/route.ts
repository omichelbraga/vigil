import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";



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
    return NextResponse.json({ error: "Invalid check ID" }, { status: 400 });
  }

  const check = await db.check.findUnique({
    where: { id },
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
  });

  if (!check) {
    return NextResponse.json({ error: "Check not found" }, { status: 404 });
  }

  return NextResponse.json(check);
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
    return NextResponse.json({ error: "Invalid check ID" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const existing = await db.check.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Check not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (
      typeof body.name !== "string" ||
      body.name.trim().length < 1 ||
      body.name.trim().length > 200
    ) {
      return NextResponse.json(
        { error: "Name must be 1-200 characters" },
        { status: 400 },
      );
    }
    data.name = body.name.trim();
  }

  if (body.type !== undefined) {
    if (!VALID_CHECK_TYPES.includes(body.type)) {
      return NextResponse.json(
        { error: `Type must be one of: ${VALID_CHECK_TYPES.join(", ")}` },
        { status: 400 },
      );
    }
    data.type = body.type;
  }

  if (body.config !== undefined) {
    if (typeof body.config !== "object" || body.config === null) {
      return NextResponse.json(
        { error: "Config must be a JSON object" },
        { status: 400 },
      );
    }
    data.config = body.config;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 },
      );
    }
    data.enabled = body.enabled;
  }

  if (body.intervalSecs !== undefined) {
    if (
      typeof body.intervalSecs !== "number" ||
      !Number.isInteger(body.intervalSecs) ||
      body.intervalSecs < 5 ||
      body.intervalSecs > 86400
    ) {
      return NextResponse.json(
        { error: "intervalSecs must be an integer between 5 and 86400" },
        { status: 400 },
      );
    }
    data.intervalSecs = body.intervalSecs;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  const updated = await db.check.update({
    where: { id },
    data,
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
    return NextResponse.json({ error: "Invalid check ID" }, { status: 400 });
  }

  const existing = await db.check.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Check not found" }, { status: 404 });
  }

  await db.check.delete({ where: { id } });

  return NextResponse.json({ message: "Check deleted" });
}
