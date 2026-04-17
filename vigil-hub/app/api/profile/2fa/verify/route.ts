import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    totpCode?: unknown;
  } | null;
  if (!body || typeof body.totpCode !== "string" || body.totpCode.length === 0) {
    return NextResponse.json({ error: "TOTP code is required" }, { status: 400 });
  }

  try {
    await auth.api.verifyTOTP({
      body: { code: body.totpCode },
      headers: req.headers,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid TOTP code";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
