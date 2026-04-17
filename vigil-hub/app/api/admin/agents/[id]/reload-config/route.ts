import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { reloadAgentConfig } from "@/lib/ws-server";

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * POST /api/admin/agents/[id]/reload-config
 *
 * Admin-only. Tells a connected agent to reload its TOML config from disk.
 * The agent responds with an `action_ack` (or `action_denied` if the
 * `allow_actions.reload_config` knob is disabled in its config).
 *
 * Returns 503 if the agent isn't currently connected.
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
    select: { id: true, name: true },
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const queued = reloadAgentConfig(id);
  if (!queued) {
    return NextResponse.json({ error: "Agent offline" }, { status: 503 });
  }

  await audit(req, auth.user.id, "agent.reload_config", {
    entityType: "agent",
    entityId: id,
    metadata: { name: agent.name },
  });

  return NextResponse.json({ queued: true });
}
