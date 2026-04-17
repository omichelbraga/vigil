import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  // Capture name for audit trail before we delete the row.
  const agent = await db.agent.findUnique({ where: { id }, select: { name: true } });

  await db.agent.delete({ where: { id } });

  await audit(req, session.user.id, "agent.reject", {
    entityType: "agent",
    entityId: id,
    metadata: agent ? { name: agent.name } : {},
  });

  return NextResponse.json({ ok: true });
}
