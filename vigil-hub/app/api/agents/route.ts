import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import argon2 from "argon2";
import crypto from "crypto";


export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agents = await db.agent.findMany({
    select: {
      id: true,
      name: true,
      lastSeen: true,
      version: true,
      os: true,
      hostname: true,
      ipAddress: true,
      isActive: true,
      status: true,
      autoUpdate: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { checks: true } },
    },
    orderBy: { name: "asc" },
  });

  const now = new Date();
  const agentsWithStatus = agents.map((a) => ({
    ...a,
    last_seen: a.lastSeen,   // snake_case alias for UI
    ip_address: a.ipAddress,
    check_count: a._count.checks,
    status:
      a.status === "pending"
        ? "pending"
        : a.lastSeen && now.getTime() - a.lastSeen.getTime() < 120_000
        ? "online"
        : "offline",
  }));

  return NextResponse.json(agentsWithStatus);
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (
    !body?.name ||
    typeof body.name !== "string" ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 100
  ) {
    return NextResponse.json(
      { error: "Name is required (1-100 chars)" },
      { status: 400 },
    );
  }

  const name = body.name.trim();

  const existing = await db.agent.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json(
      { error: "Agent name already exists" },
      { status: 409 },
    );
  }

  const token = crypto.randomUUID();
  const tokenHash = await argon2.hash(token, { type: argon2.argon2id });

  const agent = await db.agent.create({
    data: {
      name,
      tokenHash,
      autoUpdate: body.autoUpdate ?? false,
    },
  });

  return NextResponse.json(
    { id: agent.id, name: agent.name, token },
    { status: 201 },
  );
}
