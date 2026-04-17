import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

/** Parse Better Auth's signed session cookie to extract the raw token. */
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

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const currentToken = extractCurrentToken(req);

  const rows = await db.session.findMany({
    where: {
      userId: session.user.id,
      expiresAt: { gt: new Date() },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
      token: true,
    },
  });

  // Never send the raw token to the client — strip it after computing isCurrent
  const sanitized = rows.map((row) => ({
    id: row.id,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    isCurrent: currentToken !== null && row.token === currentToken,
  }));

  return NextResponse.json(sanitized);
}

export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const others = searchParams.get("others");

  if (others !== "true") {
    return NextResponse.json(
      { error: "Pass ?others=true to revoke all non-current sessions" },
      { status: 400 },
    );
  }

  const currentToken = extractCurrentToken(req);

  const where = currentToken
    ? { userId: session.user.id, NOT: { token: currentToken } }
    : { userId: session.user.id };

  const result = await db.session.deleteMany({ where });

  return NextResponse.json({ success: true, revoked: result.count });
}
