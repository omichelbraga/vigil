import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkDomain } from "@/lib/cert-monitor";
import { requireAdmin } from "@/lib/authz";
import { assertExternalHostname } from "@/lib/url-safety";
import { audit } from "@/lib/audit";



export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const certs = await db.certMonitor.findMany({
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();
  const mapped = certs.map((c) => {
    const daysRemaining = c.expiresAt
      ? Math.floor((c.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : undefined;
    return {
      id: c.id,
      domain: c.host,
      port: c.port,
      warn_days: c.warnDays,
      enabled: c.enabled,
      last_checked: c.lastChecked,
      expiry_date: c.expiresAt,
      days_remaining: daysRemaining,
      issuer: c.issuer,
      status: c.status || "unknown",
    };
  });

  return NextResponse.json(mapped);
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

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

  // SSRF guard: reject loopback/RFC1918/link-local unless VIGIL_ALLOW_INTERNAL_NET=1
  try {
    await assertExternalHostname(host);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Refused internal hostname" },
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

  await audit(req, auth.user.id, "cert.create", {
    entityType: "cert",
    entityId: cert.id,
    metadata: { host: cert.host, port: cert.port },
  });

  // Immediately check the cert in the background
  setImmediate(async () => {
    try {
      const info = await checkDomain(host, port);
      const now = new Date();
      const daysUntilExpiry = Math.floor((info.validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const status = daysUntilExpiry <= 0 ? "expired" : daysUntilExpiry <= (cert.warnDays ?? 30) ? "expiring" : "valid";
      await db.certMonitor.update({
        where: { id: cert.id },
        data: { lastChecked: now, expiresAt: info.validTo, issuer: info.issuer, status },
      });
    } catch (err) {
      await db.certMonitor.update({
        where: { id: cert.id },
        data: { lastChecked: new Date(), status: "error" },
      });
      console.error(`Initial cert check failed for ${host}:`, err);
    }
  });

  return NextResponse.json(cert, { status: 201 });
}
