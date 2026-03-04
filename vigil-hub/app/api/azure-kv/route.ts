import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { encrypt, decrypt } from "@/lib/encryption";

async function getSession(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  return session;
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const configs = await db.azureKeyVaultConfig.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      vaultUrl: true,
      tenantId: true,
      clientId: true,
      enabled: true,
      lastSynced: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json(configs);
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

  // Validate required fields
  if (!body.name || typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 200) {
    return NextResponse.json(
      { error: "Name is required (1-200 chars)" },
      { status: 400 },
    );
  }

  if (
    !body.vaultUrl ||
    typeof body.vaultUrl !== "string" ||
    !body.vaultUrl.startsWith("https://")
  ) {
    return NextResponse.json(
      { error: "vaultUrl is required and must start with https://" },
      { status: 400 },
    );
  }

  if (!body.tenantId || typeof body.tenantId !== "string" || body.tenantId.trim().length === 0) {
    return NextResponse.json(
      { error: "tenantId is required" },
      { status: 400 },
    );
  }

  if (!body.clientId || typeof body.clientId !== "string" || body.clientId.trim().length === 0) {
    return NextResponse.json(
      { error: "clientId is required" },
      { status: 400 },
    );
  }

  if (!body.clientSecret || typeof body.clientSecret !== "string" || body.clientSecret.trim().length === 0) {
    return NextResponse.json(
      { error: "clientSecret is required" },
      { status: 400 },
    );
  }

  // Encrypt the client secret before storage
  const encryptedSecret = encrypt(body.clientSecret);

  // If id is provided, update existing config
  if (body.id && typeof body.id === "string") {
    const existing = await db.azureKeyVaultConfig.findUnique({
      where: { id: body.id },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "Azure Key Vault config not found" },
        { status: 404 },
      );
    }

    const updated = await db.azureKeyVaultConfig.update({
      where: { id: body.id },
      data: {
        name: body.name.trim(),
        vaultUrl: body.vaultUrl.trim(),
        tenantId: body.tenantId.trim(),
        clientId: body.clientId.trim(),
        clientSecret: encryptedSecret,
        enabled: body.enabled ?? true,
      },
      select: {
        id: true,
        name: true,
        vaultUrl: true,
        tenantId: true,
        clientId: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(updated);
  }

  const config = await db.azureKeyVaultConfig.create({
    data: {
      name: body.name.trim(),
      vaultUrl: body.vaultUrl.trim(),
      tenantId: body.tenantId.trim(),
      clientId: body.clientId.trim(),
      clientSecret: encryptedSecret,
      enabled: body.enabled ?? true,
    },
    select: {
      id: true,
      name: true,
      vaultUrl: true,
      tenantId: true,
      clientId: true,
      enabled: true,
      createdAt: true,
    },
  });

  return NextResponse.json(config, { status: 201 });
}
