import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  channelIdForKind,
  isChannelKind,
  isIntegrationKind,
} from "@/lib/integrations";

interface RouteContext {
  params: Promise<{ kind: string }>;
}

/**
 * GET /api/admin/integrations/[kind]/deliveries?limit=50&offset=0
 * Paginated list of NotificationDelivery rows for a single channel.
 * Only channel-backed integrations have deliveries — OAuth / Azure KV return [].
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { kind } = await ctx.params;
  if (!isIntegrationKind(kind)) {
    return NextResponse.json({ error: `Unknown integration: ${kind}` }, { status: 404 });
  }
  if (!isChannelKind(kind)) {
    return NextResponse.json({ deliveries: [], total: 0 });
  }

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
    200,
  );
  const offset = Math.max(
    Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
    0,
  );

  const channelId = channelIdForKind(kind);

  const [rows, total] = await Promise.all([
    db.notificationDelivery.findMany({
      where: { channelId },
      orderBy: { sentAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        title: true,
        status: true,
        httpStatus: true,
        lastError: true,
        attempts: true,
        latencyMs: true,
        sentAt: true,
        incidentId: true,
      },
    }),
    db.notificationDelivery.count({ where: { channelId } }),
  ]);

  return NextResponse.json({
    deliveries: rows.map((r) => ({
      // BigInt → string for transport.
      id: r.id.toString(),
      title: r.title,
      status: r.status,
      httpStatus: r.httpStatus,
      lastError: r.lastError,
      attempts: r.attempts,
      latencyMs: r.latencyMs,
      sentAt: r.sentAt.toISOString(),
      incidentId: r.incidentId,
    })),
    total,
    limit,
    offset,
  });
}
