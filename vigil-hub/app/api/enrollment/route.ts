import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

function genToken(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let t = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) t += "-";
    t += chars[Math.floor(Math.random() * chars.length)];
  }
  return t;
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const token = genToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await db.enrollmentToken.create({ data: { token, expiresAt } });
  return NextResponse.json({ token, expiresAt });
}
