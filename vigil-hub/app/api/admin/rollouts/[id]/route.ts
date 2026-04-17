import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import {
  countTargetAgents,
  type RolloutTargetFilter,
} from "@/lib/rollout-target";

export interface AdminRolloutAttemptRow {
  id: string;
  agentId: string;
  agentName: string | null;
  status: string;
  versionBefore: string | null;
  versionAfter: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AdminRolloutDetail {
  id: string;
  status: string;
  release: {
    id: string;
    os: string;
    arch: string;
    version: string;
    sha256: string;
    signature: string | null;
    signedBy: string | null;
    isActive: boolean;
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
  attempts: AdminRolloutAttemptRow[];
}

/**
 * GET /api/admin/rollouts/[id] — full detail including per-agent attempts.
 * Admin only.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const job = await db.rolloutJob.findUnique({
    where: { id },
    include: {
      release: true,
      attempts: {
        orderBy: { startedAt: "desc" },
        include: {
          agent: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!job) {
    return NextResponse.json({ error: "Rollout not found" }, { status: 404 });
  }

  let createdByEmail: string | null = null;
  if (job.createdBy) {
    const u = await db.user.findUnique({
      where: { id: job.createdBy },
      select: { email: true },
    });
    createdByEmail = u?.email ?? null;
  }

  const filter = (job.targetFilter ?? {}) as RolloutTargetFilter;
  const targetsTotal = await countTargetAgents(filter, job.release).catch(() => 0);

  const detail: AdminRolloutDetail = {
    id: job.id,
    status: job.status,
    release: {
      id: job.release.id,
      os: job.release.os,
      arch: job.release.arch,
      version: job.release.version,
      sha256: job.release.sha256,
      signature: job.release.signature,
      signedBy: job.release.signedBy,
      isActive: job.release.isActive,
    },
    targetFilter: filter,
    targetsTotal,
    batchSize: job.batchSize,
    batchDelaySecs: job.batchDelaySecs,
    canaryAgentId: job.canaryAgentId,
    successCount: job.successCount,
    failureCount: job.failureCount,
    createdBy: job.createdBy,
    createdByEmail,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    attempts: job.attempts.map((a) => ({
      id: a.id,
      agentId: a.agentId,
      agentName: a.agent?.name ?? null,
      status: a.status,
      versionBefore: a.versionBefore,
      versionAfter: a.versionAfter,
      error: a.error,
      startedAt: a.startedAt.toISOString(),
      completedAt: a.completedAt ? a.completedAt.toISOString() : null,
    })),
  };

  return NextResponse.json(detail);
}
