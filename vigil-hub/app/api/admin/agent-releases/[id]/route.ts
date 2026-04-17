import { NextRequest, NextResponse } from "next/server";
import { unlink } from "fs/promises";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

const HEX_RE = /^[0-9a-fA-F]+$/;

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/**
 * PATCH /api/admin/agent-releases/[id]
 * Body: { isActive?, signature?, signedBy? }
 * - Activating a release automatically deactivates other rows for the same
 *   (os, arch) inside a single transaction.
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
  if (!body) return bad(400, "Invalid body");

  const existing = await db.agentRelease.findUnique({ where: { id } });
  if (!existing) return bad(404, "Release not found");

  const update: {
    isActive?: boolean;
    signature?: string | null;
    signedBy?: string | null;
  } = {};

  if ("isActive" in body && body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return bad(400, "isActive must be boolean");
    update.isActive = body.isActive;
  }
  if ("signature" in body && body.signature !== undefined) {
    if (body.signature === null) {
      update.signature = null;
    } else if (typeof body.signature === "string") {
      const sig = body.signature.trim().toLowerCase();
      if (sig.length !== 128 || !HEX_RE.test(sig)) {
        return bad(400, "signature must be 128 lowercase hex chars");
      }
      update.signature = sig;
    } else {
      return bad(400, "signature must be string or null");
    }
  }
  if ("signedBy" in body && body.signedBy !== undefined) {
    if (body.signedBy === null) {
      update.signedBy = null;
    } else if (typeof body.signedBy === "string") {
      const fp = body.signedBy.trim().toLowerCase();
      if (fp.length !== 8 || !HEX_RE.test(fp)) {
        return bad(400, "signedBy must be 8 lowercase hex chars");
      }
      update.signedBy = fp;
    } else {
      return bad(400, "signedBy must be string or null");
    }
  }

  if (Object.keys(update).length === 0) return bad(400, "No fields to update");

  const result = await db.$transaction(async (tx) => {
    if (update.isActive === true) {
      // Deactivate siblings first; then activate this row. Keeps only one
      // active release per (os, arch) at any time.
      await tx.agentRelease.updateMany({
        where: {
          os: existing.os,
          arch: existing.arch,
          NOT: { id: existing.id },
        },
        data: { isActive: false },
      });
    }
    return tx.agentRelease.update({
      where: { id: existing.id },
      data: update,
    });
  });

  await audit(req, authz.user.id, "agent_release.update", {
    entityId: id,
    metadata: {
      os: existing.os,
      arch: existing.arch,
      version: existing.version,
      changed: Object.keys(update),
      ...(update.isActive !== undefined ? { isActive: update.isActive } : {}),
    },
  });

  return NextResponse.json({
    id: result.id,
    os: result.os,
    arch: result.arch,
    version: result.version,
    sha256: result.sha256,
    filename: result.filename,
    filePath: result.filePath,
    fileSize: result.fileSize === null ? null : result.fileSize.toString(),
    isActive: result.isActive,
    signature: result.signature,
    signedBy: result.signedBy,
    uploadedBy: result.uploadedBy,
    uploadedAt: result.createdAt.toISOString(),
  });
}

/**
 * DELETE /api/admin/agent-releases/[id]
 * - Refuses to delete the currently-active release unless another release
 *   exists for the same (os, arch) that could be activated.
 * - Best-effort file cleanup; DB delete is the source of truth.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const target = await db.agentRelease.findUnique({ where: { id } });
  if (!target) return bad(404, "Release not found");

  if (target.isActive) {
    const alt = await db.agentRelease.findFirst({
      where: {
        os: target.os,
        arch: target.arch,
        NOT: { id: target.id },
      },
      select: { id: true },
    });
    if (!alt) {
      return bad(
        400,
        "Cannot delete the only release for this platform. Upload a replacement first.",
      );
    }
  }

  // Best-effort disk cleanup.
  if (target.filePath) {
    await unlink(target.filePath).catch(() => undefined);
  }

  await db.agentRelease.delete({ where: { id } });

  await audit(req, authz.user.id, "agent_release.delete", {
    entityId: id,
    metadata: {
      os: target.os,
      arch: target.arch,
      version: target.version,
      sha256: target.sha256,
    },
  });

  return NextResponse.json({ success: true });
}
