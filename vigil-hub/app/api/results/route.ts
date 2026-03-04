import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { Prisma } from "@prisma/client";

async function getSession(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  return session;
}

function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function isValidISODate(str: string): boolean {
  const d = new Date(str);
  return !isNaN(d.getTime());
}

const VALID_STATUSES = ["ok", "warning", "critical", "unknown"];

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);

  // Parse and validate query parameters
  const agentId = searchParams.get("agent_id");
  const checkId = searchParams.get("check_id");
  const status = searchParams.get("status");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const pageStr = searchParams.get("page") ?? "1";
  const perPageStr = searchParams.get("per_page") ?? "50";

  if (agentId && !isValidUUID(agentId)) {
    return NextResponse.json(
      { error: "Invalid agent_id format" },
      { status: 400 },
    );
  }

  if (checkId && !isValidUUID(checkId)) {
    return NextResponse.json(
      { error: "Invalid check_id format" },
      { status: 400 },
    );
  }

  if (status && !VALID_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `Status must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  if (from && !isValidISODate(from)) {
    return NextResponse.json(
      { error: "Invalid 'from' date format (ISO 8601 expected)" },
      { status: 400 },
    );
  }

  if (to && !isValidISODate(to)) {
    return NextResponse.json(
      { error: "Invalid 'to' date format (ISO 8601 expected)" },
      { status: 400 },
    );
  }

  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(perPageStr, 10) || 50));

  // Build where clause
  const where: Prisma.CheckResultWhereInput = {};

  if (agentId) where.agentId = agentId;
  if (checkId) where.checkId = checkId;
  if (status) where.status = status;

  if (from || to) {
    where.timestamp = {};
    if (from) where.timestamp.gte = new Date(from);
    if (to) where.timestamp.lte = new Date(to);
  }

  const [results, total] = await Promise.all([
    db.checkResult.findMany({
      where,
      select: {
        id: true,
        checkId: true,
        agentId: true,
        status: true,
        message: true,
        responseTimeMs: true,
        metadata: true,
        timestamp: true,
        check: { select: { id: true, name: true, type: true } },
        agent: { select: { id: true, name: true } },
      },
      orderBy: { timestamp: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.checkResult.count({ where }),
  ]);

  return NextResponse.json({
    data: results,
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  });
}
