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
  const tokenHash = crypto.createHash("sha256").update(plainToken).digest("hex");

  let name = body.hostname || "agent";
  const existing = await db.agent.findUnique({ where: { name } });
  if (existing) name = `${name}-${Date.now()}`;

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
