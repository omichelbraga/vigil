import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function extractCurrentToken(req: NextRequest): string | null {
  const cookieHeader = req.headers.get("cookie") || "";
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  const value =
    cookies["vigil.session_token"] ||
    cookies["better-auth.session_token"] ||
    cookies["__Secure-vigil.session_token"] ||
    cookies["__Secure-better-auth.session_token"];
  if (!value) return null;
  const lastDot = value.lastIndexOf(".");
  return lastDot > 0 ? value.substring(0, lastDot) : value;
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "Session id required" }, { status: 400 });
  }

  // Ensure the session we're about to revoke belongs to the caller
  const target = await db.session.findUnique({
    where: { id },
    select: { id: true, userId: true, token: true },
  });

  if (!target || target.userId !== session.user.id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const currentToken = extractCurrentToken(req);
  if (currentToken && target.token === currentToken) {
    return NextResponse.json(
      { error: "Cannot revoke the current session — use Sign Out instead" },
      { status: 400 },
    );
  }

  await db.session.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
