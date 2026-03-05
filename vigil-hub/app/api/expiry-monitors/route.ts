import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

function computeStatus(expiresAt: Date, warnDays: number): string {
  const days = Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "critical";
  if (days <= warnDays) return "warning";
  return "ok";
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const monitors = await db.expiryMonitor.findMany({ orderBy: { expiresAt: "asc" } });
  return NextResponse.json(monitors.map((m) => ({
    ...m,
    daysRemaining: Math.floor((m.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
    status: computeStatus(m.expiresAt, m.warnDays),
  })));
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.expiresAt) {
    return NextResponse.json({ error: "name and expiresAt required" }, { status: 400 });
  }

  const monitor = await db.expiryMonitor.create({
    data: {
      name: body.name,
      description: body.description || null,
      expiresAt: new Date(body.expiresAt),
      warnDays: body.warnDays ?? 30,
      category: body.category || "other",
    },
  });

  return NextResponse.json({ ...monitor, daysRemaining: Math.floor((monitor.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)), status: computeStatus(monitor.expiresAt, monitor.warnDays) }, { status: 201 });
}
