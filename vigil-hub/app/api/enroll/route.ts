import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import crypto from "crypto";

const rateLimitMap = new Map<string, number[]>();

/**
 * Pick a stable client identifier for rate-limiting.
 *
 * We only trust `x-forwarded-for` when VIGIL_TRUST_PROXY=1 is set (i.e. the
 * server is behind a known proxy that strips client-provided XFF). Otherwise
 * XFF is trivially spoofable and would let an attacker bypass rate limiting.
 */
function clientIp(req: NextRequest): string {
  if (process.env.VIGIL_TRUST_PROXY === "1") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  // NextRequest.ip is populated by the adapter when available.
  const reqIp = (req as unknown as { ip?: string }).ip;
  if (reqIp) return reqIp;
  return "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
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

  await audit(req, null, "agent.enroll", {
    entityType: "agent",
    entityId: agent.id,
    metadata: {
      name: agent.name,
      hostname: agent.hostname ?? null,
      os: agent.os ?? null,
      version: agent.version ?? null,
    },
  });

  // Prefix the agentId so the Hub can do a single-row argon2 verify on reconnect
  // (avoids O(N) scan over every active agent's hash on each WebSocket upgrade).
  const combinedToken = `${agent.id}:${plainToken}`;

  return NextResponse.json({ agent_id: agent.id, token: combinedToken }, { status: 201 });
}
