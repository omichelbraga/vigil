import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "Token id required" }, { status: 400 });
  }

  const token = await db.apiToken.findUnique({
    where: { id },
    select: { id: true, userId: true, revokedAt: true },
  });

  if (!token || token.userId !== session.user.id) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  if (token.revokedAt) {
    return NextResponse.json({ success: true, alreadyRevoked: true });
  }

  await db.apiToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ success: true });
}
