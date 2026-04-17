import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  disabledAt: string | null;
  lastSignInAt: string | null;
  sessionsCount: number;
  mfaEnabled: boolean;
  createdAt: string;
}

/**
 * GET /api/admin/users
 * Returns all users with session counts, MFA status, and profile metadata.
 * Admin-only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const now = new Date();

  const users = await db.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      avatarUrl: true,
      disabledAt: true,
      lastSignInAt: true,
      createdAt: true,
      _count: {
        select: {
          twoFactor: true,
          sessions: {
            where: { expiresAt: { gt: now } },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const rows: AdminUserRow[] = users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarUrl: u.avatarUrl,
    disabledAt: u.disabledAt ? u.disabledAt.toISOString() : null,
    lastSignInAt: u.lastSignInAt ? u.lastSignInAt.toISOString() : null,
    sessionsCount: u._count.sessions,
    mfaEnabled: u._count.twoFactor > 0,
    createdAt: u.createdAt.toISOString(),
  }));

  return NextResponse.json(rows);
}
