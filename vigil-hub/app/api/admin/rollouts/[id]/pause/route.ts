import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

/**
 * POST /api/admin/rollouts/[id]/pause — pause a rollout job. Admin only.
 * In-flight attempts are NOT cancelled — they continue until they report
 * success or time out; the runner simply stops dispatching new batches.
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
  if (job.status !== "running" && job.status !== "queued") {
    return NextResponse.json(
      { error: `Cannot pause a ${job.status} job` },
      { status: 400 },
    );
  }

  const updated = await db.rolloutJob.update({
    where: { id },
    data: { status: "paused" },
  });

  await audit(req, authz.user.id, "rollout.pause", {
    entityType: "rollout_job",
    entityId: id,
    metadata: { previousStatus: job.status },
  });

  return NextResponse.json({ id: updated.id, status: updated.status });
}
