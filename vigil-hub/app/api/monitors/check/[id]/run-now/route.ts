import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { runCheckNow } from "@/lib/ws-server";

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * POST /api/monitors/check/[id]/run-now
 *
 * Admin-only. Instructs the owning agent to execute this check immediately
 * (bypassing the normal interval). The agent runs it, pushes the result
 * through the usual `check_result` path tagged with `on_demand: true`, and
 * emits an `action_ack` we surface via SSE.
 *
 * Returns 503 if the agent isn't currently connected to this Hub — the
 * caller should treat that as "try again later".
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isUUID(id)) {
    return NextResponse.json({ error: "Invalid check id" }, { status: 400 });
  }

  const check = await db.check.findUnique({
    where: { id },
    select: { id: true, name: true, agentId: true },
  });
  if (!check) {
    return NextResponse.json({ error: "Check not found" }, { status: 404 });
  }
  if (!check.agentId) {
    return NextResponse.json(
      { error: "Check has no owning agent" },
      { status: 400 },
    );
  }

  const queued = runCheckNow(check.agentId, check.id);
  if (!queued) {
    return NextResponse.json({ error: "Agent offline" }, { status: 503 });
  }

  await audit(req, auth.user.id, "check.run_now", {
    entityType: "check",
    entityId: id,
    metadata: { name: check.name, agentId: check.agentId },
  });

  return NextResponse.json({ queued: true });
}
