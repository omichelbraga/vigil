import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await db.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      emailVerified: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(users);
}

export async function PATCH(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body?.id) return NextResponse.json({ error: "User id required" }, { status: 400 });

  const valid = ["admin", "editor", "viewer"];
  if (body.role && !valid.includes(body.role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const user = await db.user.update({
    where: { id: body.id },
    data: { ...(body.role ? { role: body.role } : {}), ...(body.name ? { name: body.name } : {}) },
    select: { id: true, name: true, email: true, role: true },
  });

  await audit(req, session.user.id, "user.update", {
    entityType: "user",
    entityId: user.id,
    metadata: {
      email: user.email,
      ...(body.role ? { role: body.role } : {}),
      ...(body.name ? { name: body.name } : {}),
    },
  });

  return NextResponse.json(user);
}

export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (id === session.user.id) return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });

  const target = await db.user.findUnique({ where: { id }, select: { email: true } });

  await db.user.delete({ where: { id } });

  await audit(req, session.user.id, "user.delete", {
    entityType: "user",
    entityId: id,
    metadata: target ? { email: target.email } : {},
  });

  return NextResponse.json({ success: true });
}
