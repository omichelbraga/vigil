import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";



export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const certs = await db.certMonitor.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      host: true,
      port: true,
      warnDays: true,
      enabled: true,
      lastChecked: true,
      expiresAt: true,
      issuer: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json(certs);
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Validate domain/host
  if (
    !body.domain ||
    typeof body.domain !== "string" ||
    body.domain.trim().length < 1 ||
    body.domain.trim().length > 253
  ) {
    return NextResponse.json(
      { error: "Domain is required (1-253 chars)" },
      { status: 400 },
    );
  }

  const host = body.domain.trim().toLowerCase();

  // Basic hostname validation: no spaces, no protocol prefix
  if (/\s/.test(host) || host.includes("://")) {
    return NextResponse.json(
      { error: "Domain must be a hostname without protocol (e.g. example.com)" },
      { status: 400 },
    );
  }

  // Validate port
  const port = body.port ?? 443;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return NextResponse.json(
      { error: "Port must be an integer between 1 and 65535" },
      { status: 400 },
    );
  }

  // Check for duplicates
  const existing = await db.certMonitor.findFirst({
    where: { host, port },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Certificate monitor for this host:port already exists" },
      { status: 409 },
    );
  }

  const cert = await db.certMonitor.create({
    data: {
      host,
      port,
      warnDays: body.warnDays ?? 30,
    },
    select: {
      id: true,
      host: true,
      port: true,
      warnDays: true,
      enabled: true,
      status: true,
      createdAt: true,
    },
  });

  return NextResponse.json(cert, { status: 201 });
}
