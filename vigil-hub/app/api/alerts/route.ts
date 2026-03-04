import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const limit = Math.min(200, parseInt(searchParams.get("limit") || "50", 10));
  const status = searchParams.get("status");

  const where = status && status !== "all" ? { status } : {};

  const alerts = await db.alertHistory.findMany({
    where,
    orderBy: { firedAt: "desc" },
    take: limit,
    include: {
      rule: { select: { name: true } },
    },
  });

  return NextResponse.json(alerts);
}
