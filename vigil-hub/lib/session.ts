import { NextRequest } from "next/server";
import { db } from "./db";

/**
 * Extract and validate a session from an incoming request.
 * Better Auth stores signed cookies as "<token>.<hmac_signature>".
 * We strip the signature and look the token up directly in the DB.
 */
export async function getSession(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie") || "";

  // Parse all cookies
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });

  // Better Auth cookie name = "<prefix>.session_token"
  const cookieValue =
    cookies["vigil.session_token"] ||
    cookies["better-auth.session_token"] ||
    cookies["__Secure-vigil.session_token"] ||
    cookies["__Secure-better-auth.session_token"];

  if (!cookieValue) return null;

  // Signed cookie format: "<token>.<signature>" — extract raw token
  const lastDot = cookieValue.lastIndexOf(".");
  const rawToken = lastDot > 0 ? cookieValue.substring(0, lastDot) : cookieValue;

  // Look up session directly in DB
  const session = await db.session.findFirst({
    where: {
      token: rawToken,
      expiresAt: { gt: new Date() },
    },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true },
      },
    },
  });

  return session ?? null;
}
