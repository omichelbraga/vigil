import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { twoFactorEnabled: true },
  });

  let backupCodesRemaining = 0;
  if (user?.twoFactorEnabled) {
    const twoFactor = await db.twoFactor.findFirst({
      where: { userId: session.user.id },
      select: { backupCodes: true },
    });
    if (twoFactor?.backupCodes) {
      // Better Auth stores backup codes as a comma-separated (or JSON) string;
      // count non-empty entries to give the user a rough idea.
      const raw = twoFactor.backupCodes;
      const parts = raw.includes(",") ? raw.split(",") : raw.split("\n");
      backupCodesRemaining = parts.map((s) => s.trim()).filter(Boolean).length;
    }
  }

  return NextResponse.json({
    enabled: !!user?.twoFactorEnabled,
    backupCodesRemaining,
  });
}
