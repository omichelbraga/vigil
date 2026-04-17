import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await db.agent.update({ where: { id }, data: { status: "active" } });

  await audit(req, session.user.id, "agent.approve", {
    entityType: "agent",
    entityId: id,
    metadata: { name: agent.name },
  });

  return NextResponse.json(agent);
}
