import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;
  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    return NextResponse.json({ error: "Current password is required" }, { status: 400 });
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return NextResponse.json(
      { error: "New password must be at least 8 characters" },
      { status: 400 },
    );
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: "New password must differ from current password" },
      { status: 400 },
    );
  }

  try {
    await auth.api.changePassword({
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      },
      headers: req.headers,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Password change failed";
    // Better Auth returns structured errors for invalid current password
    const status = /invalid|incorrect|password/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
