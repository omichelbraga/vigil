import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

interface RadarItem {
  name: string;
  daysLeft: number;
  kind: "cert" | "expiry";
  href: string;
}

interface RadarBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  topItems: RadarItem[];
}

interface RadarResponse {
  buckets: RadarBucket[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest): Promise<NextResponse<RadarResponse | { error: string }>> {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const ninetyDaysFromNow = new Date(now.getTime() + 90 * DAY_MS);

  const [certs, expiries] = await Promise.all([
    db.certMonitor.findMany({
      where: {
        enabled: true,
        expiresAt: { not: null, gte: now, lte: ninetyDaysFromNow },
      },
      select: { id: true, host: true, expiresAt: true },
      orderBy: { expiresAt: "asc" },
      take: 200,
    }),
    db.expiryMonitor.findMany({
      where: {
        expiresAt: { gte: now, lte: ninetyDaysFromNow },
      },
      select: { id: true, name: true, expiresAt: true },
      orderBy: { expiresAt: "asc" },
      take: 200,
    }),
  ]);

  const all: RadarItem[] = [];
  for (const c of certs) {
    if (!c.expiresAt) continue;
    const daysLeft = Math.floor((c.expiresAt.getTime() - now.getTime()) / DAY_MS);
    all.push({ name: c.host, daysLeft, kind: "cert", href: "/certificates" });
  }
  for (const e of expiries) {
    const daysLeft = Math.floor((e.expiresAt.getTime() - now.getTime()) / DAY_MS);
    all.push({ name: e.name, daysLeft, kind: "expiry", href: "/expiry" });
  }

  const defs: Array<{ label: string; min: number; max: number }> = [
    { label: "0-30 days", min: 0, max: 30 },
    { label: "31-60 days", min: 31, max: 60 },
    { label: "61-90 days", min: 61, max: 90 },
  ];

  const buckets: RadarBucket[] = defs.map((d) => {
    const items = all
      .filter((i) => i.daysLeft >= d.min && i.daysLeft <= d.max)
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return {
      label: d.label,
      min: d.min,
      max: d.max,
      count: items.length,
      topItems: items.slice(0, 3),
    };
  });

  return NextResponse.json({ buckets });
}
