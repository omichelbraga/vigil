import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

/**
 * POST /api/admin/users/[id]/force-logout
 * Revokes every active session belonging to the target user.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const result = await db.session.deleteMany({ where: { userId: id } });

  await audit(req, authz.user.id, "user.force_logout", {
    entityId: id,
    metadata: { email: target.email, sessionsRevoked: result.count },
  });

  return NextResponse.json({ success: true, sessionsRevoked: result.count });
}
