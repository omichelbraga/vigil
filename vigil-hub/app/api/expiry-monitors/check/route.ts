import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { runExpiryChecks } from "@/lib/expiry-monitor";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await runExpiryChecks();
  return NextResponse.json(result);
}
