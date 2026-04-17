import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

type Role = "admin" | "editor" | "viewer";
const MUTATING_ROLES: readonly Role[] = ["admin", "editor"] as const;

interface AckResponse {
  id: string;
  status: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<AckResponse | { error: string }>> {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = (session.user as { role?: Role } | undefined)?.role;
  if (!role || !MUTATING_ROLES.includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await db.incident.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Incident not found" }, { status: 404 });
  }
  if (existing.status === "resolved") {
    return NextResponse.json(
      { error: "Cannot acknowledge a resolved incident" },
      { status: 409 },
    );
  }

  const now = new Date();
  const updated = await db.incident.update({
    where: { id },
    data: {
      status: "acknowledged",
      acknowledgedAt: now,
      acknowledgedBy: session.user.id,
    },
    select: {
      id: true,
      status: true,
      acknowledgedAt: true,
      acknowledgedBy: true,
    },
  });

  await audit(req, session.user.id, "incident.acknowledge", {
    entityType: "incident",
    entityId: id,
  });

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    acknowledgedAt: updated.acknowledgedAt ? updated.acknowledgedAt.toISOString() : null,
    acknowledgedBy: updated.acknowledgedBy,
  });
}
