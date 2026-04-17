import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    password?: unknown;
  } | null;
  if (!body || typeof body.password !== "string" || body.password.length === 0) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  try {
    const result = await auth.api.generateBackupCodes({
      body: { password: body.password },
      headers: req.headers,
    });
    return NextResponse.json({ backupCodes: result.backupCodes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not regenerate backup codes";
    const status = /password|invalid|credentials/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
