import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

/**
 * POST /api/admin/rollouts/[id]/cancel — terminally fail a rollout. Admin only.
 * Any pending attempts are marked `skipped` so they don't confuse dashboards;
 * in-flight attempts are NOT auto-cancelled — they continue until natural
 * success/timeout because we can't un-send an `update_now` already in flight.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const job = await db.rolloutJob.findUnique({ where: { id } });
  if (!job) {
    return NextResponse.json({ error: "Rollout not found" }, { status: 404 });
  }
  if (job.status === "completed" || job.status === "failed") {
    return NextResponse.json(
      { error: `Cannot cancel a ${job.status} job` },
      { status: 400 },
    );
  }

  const { skipped } = await db.$transaction(async (tx) => {
    const skip = await tx.rolloutAttempt.updateMany({
      where: { jobId: id, status: "pending" },
      data: {
        status: "skipped",
        completedAt: new Date(),
        error: "Job cancelled by operator",
      },
    });
    await tx.rolloutJob.update({
      where: { id },
      data: {
        status: "failed",
        completedAt: new Date(),
      },
    });
    return { skipped: skip.count };
  });

  await audit(req, authz.user.id, "rollout.cancel", {
    entityType: "rollout_job",
    entityId: id,
    metadata: {
      previousStatus: job.status,
      skippedAttempts: skipped,
      reason: "cancelled",
    },
  });

  return NextResponse.json({ id, status: "failed", skippedAttempts: skipped });
}
