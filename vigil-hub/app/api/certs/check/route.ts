import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { runCertChecks } from "@/lib/cert-monitor";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await runCertChecks();
  return NextResponse.json({ ok: true });
}
