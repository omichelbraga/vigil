import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import {
  parseAuditFilters,
  buildAuditWhere,
} from "@/lib/admin-audit-filters";

// Hard cap on exported rows — stops accidental whole-table CSV dumps.
const EXPORT_MAX_ROWS = 10_000;

/** RFC 4180 CSV cell escaping — wrap in quotes, double up embedded quotes. */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s =
    typeof value === "string"
      ? value
      : value instanceof Date
        ? value.toISOString()
        : JSON.stringify(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const parsed = parseAuditFilters(req);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const where = buildAuditWhere(parsed.filters);

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return NextResponse.json(
      { error: "format must be 'csv' or 'json'" },
      { status: 400 },
    );
  }

  const rows = await db.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: EXPORT_MAX_ROWS,
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
  });

  const mapped = rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const entityId = meta.entityId;
    const ua = meta.userAgent;
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      action: r.action,
      resource: r.resource,
      actorId: r.user?.id ?? null,
      actorEmail: r.user?.email ?? null,
      entityType: r.resource,
      entityId: typeof entityId === "string" ? entityId : null,
      ipAddress: r.ipAddress,
      userAgent: typeof ua === "string" ? ua : null,
      metadata: r.metadata ?? null,
    };
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (format === "json") {
    return new NextResponse(JSON.stringify(mapped, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${stamp}.json"`,
      },
    });
  }

  // CSV
  const headers = [
    "id",
    "createdAt",
    "action",
    "resource",
    "actorId",
    "actorEmail",
    "entityType",
    "entityId",
    "ipAddress",
    "userAgent",
    "metadata",
  ];
  const lines: string[] = [headers.map(csvEscape).join(",")];
  for (const row of mapped) {
    lines.push(
      [
        row.id,
        row.createdAt,
        row.action,
        row.resource,
        row.actorId,
        row.actorEmail,
        row.entityType,
        row.entityId,
        row.ipAddress,
        row.userAgent,
        row.metadata,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const body = lines.join("\r\n") + "\r\n";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${stamp}.csv"`,
    },
  });
}
