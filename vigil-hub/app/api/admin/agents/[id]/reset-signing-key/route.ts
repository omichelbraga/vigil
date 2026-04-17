import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { invalidateSigningContext } from "@/lib/ws-server";

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * POST /api/admin/agents/[id]/reset-signing-key
 *
 * Admin-only. Clears `Agent.resultSigningPubkey` +
 * `Agent.resultSigningPubkeyPinnedAt`, so the next `register` from the agent
 * re-pins a fresh key. Use this when:
 *  * The agent's keypair on disk was destroyed (agent-key.pem wiped) and the
 *    agent regenerated a new one.
 *  * A host was cloned and the pinned pubkey no longer matches the running
 *    binary's key.
 *  * An incident response flow requires a forced re-pin.
 *
 * The window between the reset and the next register is tamper-evidence-off:
 * we'll accept unsigned messages during that grace period. Operators should
 * prefer triggering this right before an expected reconnect.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isUUID(id)) {
    return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });
  }

  const agent = await db.agent.findUnique({
    where: { id, isActive: true },
    select: {
      id: true,
      name: true,
      resultSigningPubkey: true,
      resultSigningPubkeyPinnedAt: true,
    },
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  await db.agent.update({
    where: { id },
    data: {
      resultSigningPubkey: null,
      resultSigningPubkeyPinnedAt: null,
    },
  });
  invalidateSigningContext(id);

  await audit(req, auth.user.id, "agent.reset_signing_key", {
    entityType: "agent",
    entityId: id,
    metadata: {
      name: agent.name,
      previousPubkeyPrefix:
        agent.resultSigningPubkey?.slice(0, 16) ?? null,
      previousPinnedAt: agent.resultSigningPubkeyPinnedAt?.toISOString() ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}
