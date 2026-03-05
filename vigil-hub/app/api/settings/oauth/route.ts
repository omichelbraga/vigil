import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Public endpoint — no auth required. Only exposes enabled flags, no secrets.
export async function GET() {
  const configs = await db.appConfig.findMany({
    where: {
      key: { in: ["oauth_google_enabled", "oauth_microsoft_enabled"] },
    },
  });

  const map = Object.fromEntries(configs.map((c) => [c.key, c.value]));

  return NextResponse.json({
    google_enabled: map["oauth_google_enabled"] === "true",
    microsoft_enabled: map["oauth_microsoft_enabled"] === "true",
  });
}
