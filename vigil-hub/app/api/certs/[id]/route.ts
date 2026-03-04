import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";



function isValidUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  return NextResponse.json({ message: "Certificate monitor deleted" });
}
