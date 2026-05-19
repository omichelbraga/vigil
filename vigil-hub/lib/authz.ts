import { NextRequest, NextResponse } from "next/server";
import { getSession } from "./session";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
};

export type AuthzResult =
  | {
      ok: true;
      user: SessionUser;
      /** Scopes the caller's credentials carry. Cookie sessions get all three. */
      scopes: string[];
      /** True when the session was derived from an API token, not a cookie. */
      fromApiToken: boolean;
    }
  | { ok: false; response: NextResponse };

/** Require any authenticated session (cookie OR API token). */
export async function requireSession(req: NextRequest): Promise<AuthzResult> {
  const session = await getSession(req);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return {
    ok: true,
    user: session.user,
    scopes: session.scopes,
    fromApiToken: session.fromApiToken,
  };
}

/**
 * Require a session with role === "admin". When the session came from an API
 * token (CLI / CI), the token must also carry the "admin" scope — a token
 * minted with only read/write can't touch admin routes even if the owner is
 * an admin user.
 */
export async function requireAdmin(req: NextRequest): Promise<AuthzResult> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth;
  if (auth.user.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden: admin role required" },
        { status: 403 },
      ),
    };
  }
  if (auth.fromApiToken && !auth.scopes.includes("admin")) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden: API token lacks 'admin' scope" },
        { status: 403 },
      ),
    };
  }
  return auth;
}
