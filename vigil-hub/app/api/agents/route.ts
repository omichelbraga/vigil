import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getConnectedAgentIds } from "@/lib/ws-server";
import { audit } from "@/lib/audit";
import argon2 from "argon2";
import crypto from "crypto";


export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agents = await db.agent.findMany({
    where: { isActive: true, NOT: { tokenHash: "hub-internal" } },
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
      resultSigningPubkey: true,
      resultSigningPubkeyPinnedAt: true,
      _count: { select: { checks: true } },
    },
    orderBy: { name: "asc" },
  });

  const connectedIds = getConnectedAgentIds();
  const agentsWithStatus = agents.map((a) => ({
    ...a,
    last_seen: a.lastSeen,
    ip_address: a.ipAddress,
    check_count: a._count.checks,
    // P6.4 — surface whether we've pinned a signing pubkey for this agent.
    // Only ship a 16-char prefix; the full key has no business on the wire.
    result_signing_pinned: a.resultSigningPubkey !== null,
    result_signing_pubkey_prefix:
      a.resultSigningPubkey?.slice(0, 16) ?? null,
    result_signing_pinned_at: a.resultSigningPubkeyPinnedAt,
    status:
      a.status === "pending"
        ? "pending"
        : connectedIds.has(a.id)
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

  const existing = await db.agent.findFirst({ where: { name, isActive: true } });
  if (existing) {
    return NextResponse.json(
      { error: "Agent name already exists" },
      { status: 409 },
    );
  }

  const token = crypto.randomUUID();
  const tokenHash = await argon2.hash(token, { type: argon2.argon2id });

  let agent;
  try {
    agent = await db.agent.create({
      data: {
        name,
        tokenHash,
        autoUpdate: body.autoUpdate ?? false,
      },
    });
  } catch (e: unknown) {
    // Handle DB-level unique constraint (name taken by a soft-deleted record)
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      // Force-delete the ghost record and retry
      await db.agent.deleteMany({ where: { name, isActive: false } });
      agent = await db.agent.create({
        data: { name, tokenHash, autoUpdate: body.autoUpdate ?? false },
      });
    } else {
      throw e;
    }
  }

  await audit(req, session.user.id, "agent.create", {
    entityType: "agent",
    entityId: agent.id,
    metadata: { name: agent.name, autoUpdate: agent.autoUpdate },
  });

  return NextResponse.json(
    { id: agent.id, name: agent.name, token },
    { status: 201 },
  );
}
