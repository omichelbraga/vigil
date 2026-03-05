import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import crypto from "crypto";

const rateLimitMap = new Map<string, number[]>();

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < 3600000);
  if (hits.length >= 10) return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  rateLimitMap.set(ip, [...hits, now]);

  const body = await req.json().catch(() => null);
  if (!body?.enrollment_token) return NextResponse.json({ error: "Missing enrollment_token" }, { status: 400 });

  const et = await db.enrollmentToken.findUnique({ where: { token: body.enrollment_token } });
  if (!et || et.usedAt || et.expiresAt < new Date()) {
    return NextResponse.json({ error: "Invalid or expired enrollment token" }, { status: 401 });
  }

  const plainToken = crypto.randomUUID();
  const argon2 = await import("argon2");
  const tokenHash = await argon2.default.hash(plainToken, { type: argon2.default.argon2id });

  let name = (body.hostname || "agent") as string;
  // If name is taken by an active agent, append a short suffix; delete ghost (inactive) records
  const existing = await db.agent.findFirst({ where: { name, isActive: true } });
  if (existing) {
    // Increment suffix: MIKE-PC-HOST → MIKE-PC-HOST-2 → MIKE-PC-HOST-3
    let suffix = 2;
    while (await db.agent.findFirst({ where: { name: `${name}-${suffix}`, isActive: true } })) suffix++;
    name = `${name}-${suffix}`;
  }
  // Clean up any inactive ghost records with this name
  await db.agent.deleteMany({ where: { name, isActive: false } });

  const agent = await db.agent.create({
    data: {
      name,
      tokenHash,
      status: "pending",
      hostname: body.hostname,
      os: body.os,
      version: body.version,
      ipAddress: body.ip,
      enrolledAt: new Date(),
    },
  });

  await db.enrollmentToken.update({ where: { id: et.id }, data: { usedAt: new Date(), agentId: agent.id } });

  return NextResponse.json({ agent_id: agent.id, token: plainToken }, { status: 201 });
}
