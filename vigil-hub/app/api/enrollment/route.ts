import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { randomBytes } from "crypto";

function genToken(): string {
  // 64 bits of entropy from a CSPRNG, rendered in an unambiguous alphabet.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars = 5 bits each
  const buf = randomBytes(8);
  let t = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) t += "-";
    t += chars[buf[i] & 0x1f];
  }
  return t;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const token = genToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await db.enrollmentToken.create({ data: { token, expiresAt } });

  await audit(req, auth.user.id, "enrollment.token_issued", {
    entityType: "enrollment_token",
    metadata: { expiresAt: expiresAt.toISOString() },
  });

  return NextResponse.json({ token, expiresAt });
}
