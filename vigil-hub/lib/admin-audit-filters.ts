import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";

export interface AuditFilters {
  actorId?: string;
  action?: string;
  entityType?: string;
  from?: Date;
  to?: Date;
  showSystem: boolean;
  page: number;
  perPage: number;
}

export type ParseResult =
  | { ok: true; filters: AuditFilters }
  | { ok: false; error: string };

/** Parse and validate audit-log query parameters shared by list + export. */
export function parseAuditFilters(req: NextRequest): ParseResult {
  const { searchParams } = new URL(req.url);

  const actorId = searchParams.get("actorId") ?? undefined;
  const action = searchParams.get("action") ?? undefined;
  const entityType = searchParams.get("entityType") ?? undefined;

  const fromStr = searchParams.get("from");
  const toStr = searchParams.get("to");
  let from: Date | undefined;
  let to: Date | undefined;
  if (fromStr) {
    const d = new Date(fromStr);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid 'from' timestamp" };
    from = d;
  }
  if (toStr) {
    const d = new Date(toStr);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid 'to' timestamp" };
    to = d;
  }

  const showSystem =
    searchParams.get("showSystem") === "1" ||
    searchParams.get("showSystem") === "true";

  const pageRaw = Number(searchParams.get("page") ?? "1");
  const perPageRaw = Number(searchParams.get("per_page") ?? "50");
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPage =
    Number.isInteger(perPageRaw) && perPageRaw > 0
      ? Math.min(perPageRaw, 200)
      : 50;

  return {
    ok: true,
    filters: { actorId, action, entityType, from, to, showSystem, page, perPage },
  };
}

/** Build a Prisma `where` clause from parsed audit filters. */
export function buildAuditWhere(f: AuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};

  if (f.actorId) {
    where.userId = f.actorId;
  } else if (!f.showSystem) {
    where.userId = { not: null };
  }

  if (f.action) {
    where.action = { startsWith: f.action };
  }

  if (f.entityType) {
    where.resource = f.entityType;
  }

  if (f.from || f.to) {
    where.createdAt = {};
    if (f.from) where.createdAt.gte = f.from;
    if (f.to) where.createdAt.lte = f.to;
  }

  return where;
}
