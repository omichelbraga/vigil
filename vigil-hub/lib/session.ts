import { NextRequest } from "next/server";
import { db } from "./db";
import { verifyApiToken } from "./api-tokens";

/**
 * Shape returned by getSession() for both cookie-based sessions (Better Auth)
 * and personal API tokens. Callers can inspect `fromApiToken` + `scopes` when
 * they want to apply scope-based authorization on top of role checks.
 */
export interface AppSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string | null;
  };
  /** ["read","write","admin"] for cookie sessions (full access); a subset for API tokens. */
  scopes: string[];
  fromApiToken: boolean;
}

const FULL_SCOPES: string[] = ["read", "write", "admin"];

/**
 * Extract and validate a session from an incoming request.
 *
 * Order:
 *   1. Better Auth signed cookie ("<token>.<hmac>" format) — primary browser flow
 *   2. `Authorization: Bearer vgl_…` personal API token — CLI / CI / scripted clients
 *
 * Returns `null` when neither path produces a valid session.
 */
export async function getSession(req: NextRequest): Promise<AppSession | null> {
  return (await tryCookieSession(req)) ?? (await tryApiTokenSession(req));
}

async function tryCookieSession(req: NextRequest): Promise<AppSession | null> {
  const cookieHeader = req.headers.get("cookie") || "";
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });

  const cookieValue =
    cookies["vigil.session_token"] ||
    cookies["better-auth.session_token"] ||
    cookies["__Secure-vigil.session_token"] ||
    cookies["__Secure-better-auth.session_token"];

  if (!cookieValue) return null;

  // Signed cookie format: "<token>.<signature>" — extract raw token.
  const lastDot = cookieValue.lastIndexOf(".");
  const rawToken = lastDot > 0 ? cookieValue.substring(0, lastDot) : cookieValue;

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

  if (!session) return null;
  return {
    user: session.user,
    scopes: FULL_SCOPES,
    fromApiToken: false,
  };
}

async function tryApiTokenSession(req: NextRequest): Promise<AppSession | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(vgl_[A-Za-z0-9_-]+)$/.exec(auth);
  if (!m) return null;
  const plaintext = m[1];

  // Token prefix narrows the argon2 search to one row in the common case
  // without leaking through timing — the verify call is still constant-time.
  const prefix = plaintext.slice(0, 8);
  const candidates = await db.apiToken.findMany({
    where: {
      tokenPrefix: prefix,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true },
      },
    },
  });

  for (const t of candidates) {
    if (await verifyApiToken(t.tokenHash, plaintext)) {
      // Best-effort: bump lastUsedAt. Fire and forget.
      db.apiToken
        .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
      return {
        user: t.user,
        scopes: t.scopes,
        fromApiToken: true,
      };
    }
  }
  return null;
}
