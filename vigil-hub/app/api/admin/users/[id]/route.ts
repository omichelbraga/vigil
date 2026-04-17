import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

type Role = "admin" | "editor" | "viewer";
const VALID_ROLES: readonly Role[] = ["admin", "editor", "viewer"] as const;

function isRole(v: unknown): v is Role {
  return typeof v === "string" && (VALID_ROLES as readonly string[]).includes(v);
}

async function countAdmins(excludeUserId?: string): Promise<number> {
  return db.user.count({
    where: {
      role: "admin",
      disabledAt: null,
      ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
    },
  });
}

/**
 * PATCH /api/admin/users/[id]
 * Body: { role?, name?, disabled? }
 * - Role must be admin|editor|viewer.
 * - Prevents demoting (or disabling) the last active admin.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, role: true, disabledAt: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const update: { role?: Role; name?: string; disabledAt?: Date | null } = {};

  if ("role" in body && body.role !== undefined) {
    if (!isRole(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    // If demoting the last active admin, refuse.
    if (target.role === "admin" && body.role !== "admin") {
      const remaining = await countAdmins(target.id);
      if (remaining === 0) {
        return NextResponse.json(
          { error: "Cannot demote the last active admin" },
          { status: 400 },
        );
      }
    }
    update.role = body.role;
  }

  if ("name" in body && body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length === 0) {
      return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    }
    update.name = body.name;
  }

  if ("disabled" in body && body.disabled !== undefined) {
    const shouldDisable = body.disabled === true;
    if (shouldDisable) {
      // Prevent disabling the last active admin.
      if (target.role === "admin" && !target.disabledAt) {
        const remaining = await countAdmins(target.id);
        if (remaining === 0) {
          return NextResponse.json(
            { error: "Cannot disable the last active admin" },
            { status: 400 },
          );
        }
      }
      update.disabledAt = new Date();
    } else {
      update.disabledAt = null;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id },
    data: update,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      disabledAt: true,
    },
  });

  // If disabling, also purge sessions so the user is kicked immediately.
  if (update.disabledAt) {
    await db.session.deleteMany({ where: { userId: id } });
  }

  await audit(req, authz.user.id, "user.update", {
    entityId: id,
    metadata: {
      email: target.email,
      changed: Object.keys(update),
      ...(update.role ? { role: update.role } : {}),
      ...(update.disabledAt !== undefined
        ? { disabled: update.disabledAt !== null }
        : {}),
    },
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/admin/users/[id]
 * - Prevents self-delete.
 * - Prevents deleting the last active admin.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;

  if (id === authz.user.id) {
    return NextResponse.json(
      { error: "Cannot delete your own account" },
      { status: 400 },
    );
  }

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, role: true, email: true, disabledAt: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (target.role === "admin") {
    const remaining = await countAdmins(target.id);
    if (remaining === 0) {
      return NextResponse.json(
        { error: "Cannot delete the last active admin" },
        { status: 400 },
      );
    }
  }

  await db.user.delete({ where: { id } });

  await audit(req, authz.user.id, "user.delete", {
    entityId: id,
    metadata: { email: target.email, role: target.role },
  });

  return NextResponse.json({ success: true });
}
