import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import argon2 from "argon2";
import crypto from "crypto";

async function getSession(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  return session;
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agents = await db.agent.findMany({
    where: { isActive: true },
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
      _count: { select: { checks: true } },
    },
    orderBy: { name: "asc" },
  });

  const now = new Date();
  const agentsWithStatus = agents.map((a) => ({
    ...a,
    status:
      a.lastSeen && now.getTime() - a.lastSeen.getTime() < 120_000
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
