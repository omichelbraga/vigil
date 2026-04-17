import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

async function handleUpdate(req: NextRequest, id: string) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data: Record<string, unknown> = {
    ...(body.name && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.expiresAt && { expiresAt: new Date(body.expiresAt) }),
    ...(body.warnDays !== undefined && { warnDays: body.warnDays }),
    ...(body.category && { category: body.category }),
  };

  const monitor = await db.expiryMonitor.update({
    where: { id },
    data,
  });

  await audit(req, session.user.id, "expiry.update", {
    entityType: "expiry",
    entityId: id,
    metadata: { changedFields: Object.keys(data) },
  });

  return NextResponse.json(monitor);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleUpdate(req, id);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleUpdate(req, id);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const existing = await db.expiryMonitor.findUnique({ where: { id }, select: { name: true } });

  await db.expiryMonitor.delete({ where: { id } });

  await audit(req, session.user.id, "expiry.delete", {
    entityType: "expiry",
    entityId: id,
    metadata: existing ? { name: existing.name } : {},
  });

  return NextResponse.json({ ok: true });
}
