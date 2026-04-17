import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import {
  parseAuditFilters,
  buildAuditWhere,
} from "@/lib/admin-audit-filters";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const parsed = parseAuditFilters(req);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { filters } = parsed;
  const where = buildAuditWhere(filters);

  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.perPage,
      take: filters.perPage,
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    }),
  ]);

  const items = rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const uaRaw = meta.userAgent;
    const entityIdRaw = meta.entityId;
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      action: r.action,
      resource: r.resource,
      actor: r.user
        ? { id: r.user.id, email: r.user.email, name: r.user.name }
        : null,
      entityType: r.resource,
      entityId: typeof entityIdRaw === "string" ? entityIdRaw : null,
      ipAddress: r.ipAddress,
      userAgent: typeof uaRaw === "string" ? uaRaw : null,
      metadata: r.metadata,
    };
  });

  return NextResponse.json({
    items,
    total,
    page: filters.page,
    perPage: filters.perPage,
  });
}
