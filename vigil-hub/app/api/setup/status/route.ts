import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const count = await db.user.count();
  return NextResponse.json({ needsSetup: count === 0 });
}
