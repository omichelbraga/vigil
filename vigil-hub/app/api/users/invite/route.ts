import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const valid = ["admin", "editor", "viewer"];
  const role = valid.includes(body.role) ? body.role : "viewer";

  // Check if user already exists
  const existing = await db.user.findUnique({ where: { email: body.email } });
  if (existing) return NextResponse.json({ error: "User already exists" }, { status: 409 });

  try {
    await auth.api.signUpEmail({
      body: {
        email: body.email,
        password: body.password,
        name: body.name || body.email.split("@")[0],
      },
    });

    // Better Auth does not persist custom roles via signUpEmail — force-set role in DB
    await db.user.updateMany({
      where: { email: body.email },
      data: { role },
    });

    const user = await db.user.findUnique({
      where: { email: body.email },
      select: { id: true, email: true, name: true, role: true },
    });

    await audit(req, session.user.id, "user.invite", {
      entityType: "user",
      entityId: user?.id,
      metadata: { email: body.email, role },
    });

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
