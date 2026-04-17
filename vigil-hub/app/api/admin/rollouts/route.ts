import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import {
  parseTargetFilter,
  countTargetAgents,
  type RolloutTargetFilter,
} from "@/lib/rollout-target";

export interface AdminRolloutListRow {
  id: string;
  status: string;
  release: {
    id: string;
    os: string;
    arch: string;
    version: string;
  };
  targetFilter: RolloutTargetFilter;
  targetsTotal: number;
  batchSize: number;
  batchDelaySecs: number;
  canaryAgentId: string | null;
  successCount: number;
  failureCount: number;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const MAX_PER_PAGE = 100;

/**
 * GET /api/admin/rollouts — list with basic pagination. Admin only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const perPageRaw = Number.parseInt(url.searchParams.get("perPage") ?? "25", 10);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number.isFinite(perPageRaw) ? perPageRaw : 25));

  const [total, rows] = await Promise.all([
    db.rolloutJob.count(),
    db.rolloutJob.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        release: {
          select: { id: true, os: true, arch: true, version: true },
        },
      },
    }),
  ]);

  // Resolve createdBy → email for display (cheap — small batch). Skip null uploaders.
  const actorIds = Array.from(new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x)));
  const actors = actorIds.length > 0
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, email: true },
      })
    : [];
  const actorEmail = new Map(actors.map((a) => [a.id, a.email]));

  const items: AdminRolloutListRow[] = await Promise.all(
    rows.map(async (r): Promise<AdminRolloutListRow> => {
      const filter = (r.targetFilter ?? {}) as RolloutTargetFilter;
      const total = await countTargetAgents(filter, r.release).catch(() => 0);
      return {
        id: r.id,
        status: r.status,
        release: r.release,
        targetFilter: filter,
        targetsTotal: total,
        batchSize: r.batchSize,
        batchDelaySecs: r.batchDelaySecs,
        canaryAgentId: r.canaryAgentId,
        successCount: r.successCount,
        failureCount: r.failureCount,
        createdBy: r.createdBy,
        createdByEmail: r.createdBy ? actorEmail.get(r.createdBy) ?? null : null,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      };
    }),
  );

  return NextResponse.json({ items, total, page, perPage });
}

interface CreateRolloutBody {
  releaseId?: unknown;
  targetFilter?: unknown;
  batchSize?: unknown;
  batchDelaySecs?: unknown;
  canaryAgentId?: unknown;
}

/**
 * POST /api/admin/rollouts — create a new rollout job. Admin only. Writes an
 * audit row. The runner picks up `running` jobs on the next tick (≤30s).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  let body: CreateRolloutBody;
  try {
    body = (await req.json()) as CreateRolloutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.releaseId !== "string" || body.releaseId.length === 0) {
    return NextResponse.json({ error: "releaseId is required" }, { status: 400 });
  }
  const filterParse = parseTargetFilter(body.targetFilter);
  if (!filterParse.ok) {
    return NextResponse.json({ error: filterParse.error }, { status: 400 });
  }

  const batchSize = Number(body.batchSize);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    return NextResponse.json(
      { error: "batchSize must be an integer between 1 and 1000" },
      { status: 400 },
    );
  }
  const batchDelaySecs = Number(body.batchDelaySecs);
  if (!Number.isInteger(batchDelaySecs) || batchDelaySecs < 0 || batchDelaySecs > 86_400) {
    return NextResponse.json(
      { error: "batchDelaySecs must be an integer between 0 and 86400" },
      { status: 400 },
    );
  }

  let canaryAgentId: string | null = null;
  if (body.canaryAgentId !== undefined && body.canaryAgentId !== null && body.canaryAgentId !== "") {
    if (typeof body.canaryAgentId !== "string") {
      return NextResponse.json(
        { error: "canaryAgentId must be a string" },
        { status: 400 },
      );
    }
    canaryAgentId = body.canaryAgentId;
  }

  const release = await db.agentRelease.findUnique({
    where: { id: body.releaseId },
  });
  if (!release) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }
  if (!release.isActive) {
    return NextResponse.json(
      { error: "Release is not active — activate it before rolling out." },
      { status: 400 },
    );
  }
  if (!release.sha256 || !release.signature) {
    return NextResponse.json(
      { error: "Release is missing sha256 or signature — cannot safely push." },
      { status: 400 },
    );
  }

  if (canaryAgentId) {
    const canary = await db.agent.findUnique({ where: { id: canaryAgentId } });
    if (!canary) {
      return NextResponse.json(
        { error: "canaryAgentId does not match any agent" },
        { status: 400 },
      );
    }
  }

  const job = await db.rolloutJob.create({
    data: {
      releaseId: release.id,
      targetFilter: filterParse.filter as unknown as object,
      batchSize,
      batchDelaySecs,
      canaryAgentId,
      status: "running",
      createdBy: authz.user.id,
      startedAt: new Date(),
    },
  });

  await audit(req, authz.user.id, "rollout.create", {
    entityType: "rollout_job",
    entityId: job.id,
    metadata: JSON.parse(
      JSON.stringify({
        releaseId: release.id,
        releaseVersion: release.version,
        os: release.os,
        arch: release.arch,
        batchSize,
        batchDelaySecs,
        canaryAgentId,
        targetFilter: filterParse.filter,
      }),
    ),
  });

  return NextResponse.json(
    {
      id: job.id,
      status: job.status,
      releaseId: job.releaseId,
      createdAt: job.createdAt.toISOString(),
    },
    { status: 201 },
  );
}
