import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import {
  generateApiToken,
  hashApiToken,
  resolveExpiry,
  sanitizeScopes,
} from "@/lib/api-tokens";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const showRevoked = searchParams.get("showRevoked") === "true";

  const tokens = await db.apiToken.findMany({
    where: {
      userId: session.user.id,
      ...(showRevoked ? {} : { revokedAt: null }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(tokens);
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    scopes?: unknown;
    expiresAt?: unknown;
  } | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (name.length > 80) {
    return NextResponse.json({ error: "Name is too long (max 80)" }, { status: 400 });
  }

  const scopes = sanitizeScopes(body.scopes);
  if (scopes.length === 0) {
    return NextResponse.json(
      { error: "At least one scope required (read, write, admin)" },
      { status: 400 },
    );
  }

  const expiresAt =
    typeof body.expiresAt === "string" ? resolveExpiry(body.expiresAt) : null;

  const { plaintext, displayPrefix } = generateApiToken();
  const tokenHash = await hashApiToken(plaintext);

  const created = await db.apiToken.create({
    data: {
      userId: session.user.id,
      name,
      tokenHash,
      tokenPrefix: displayPrefix,
      scopes,
      expiresAt,
    },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      scopes: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  // plaintext is returned exactly once. Never stored, never logged.
  return NextResponse.json({ ...created, plaintext }, { status: 201 });
}
