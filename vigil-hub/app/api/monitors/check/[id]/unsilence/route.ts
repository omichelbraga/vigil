import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { silenceCheckOnAgent } from "@/lib/ws-server";

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

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

  const existing = await db.check.findUnique({
    where: { id },
    select: { id: true, name: true, agentId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Check not found" }, { status: 404 });
  }

  const updated = await db.check.update({
    where: { id },
    data: { silencedUntil: null },
    select: { id: true, name: true, silencedUntil: true },
  });

  // Best-effort: clear the silence on the agent side too.
  let pushedToAgent = false;
  if (existing.agentId) {
    pushedToAgent = silenceCheckOnAgent(existing.agentId, id, null);
  }

  await audit(req, auth.user.id, "check.unsilence", {
    entityType: "check",
    entityId: id,
    metadata: { name: existing.name, pushedToAgent },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    silencedUntil: updated.silencedUntil?.toISOString() ?? null,
    pushedToAgent,
  });
}
