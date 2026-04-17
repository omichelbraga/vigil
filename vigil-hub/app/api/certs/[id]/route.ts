import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";

function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!isValidUUID(id)) {
    return NextResponse.json(
      { error: "Invalid cert monitor ID" },
      { status: 400 },
    );
  }

  const existing = await db.certMonitor.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json(
      { error: "Certificate monitor not found" },
      { status: 404 },
    );
  }

  await db.certMonitor.delete({ where: { id } });

  await audit(req, auth.user.id, "cert.delete", {
    entityType: "cert",
    entityId: id,
    metadata: { host: existing.host, port: existing.port },
  });

  return NextResponse.json({ message: "Certificate monitor deleted" });
}
