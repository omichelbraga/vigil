import { NextRequest, NextResponse } from "next/server";
import { getSession } from "./session";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
};

export type AuthzResult =
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse };

/** Require any authenticated session. */
export async function requireSession(req: NextRequest): Promise<AuthzResult> {
  const session = await getSession(req);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, user: session.user as SessionUser };
}

/** Require a session with role === "admin". */
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
  return auth;
}
