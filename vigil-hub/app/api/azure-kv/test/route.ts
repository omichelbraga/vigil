import { getSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

import { decrypt } from "@/lib/encryption";


export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let vaultUrl: string;
  let tenantId: string;
  let clientId: string;
  let clientSecret: string;

  // If an existing config id is provided, load credentials from the database
  if (body.id && typeof body.id === "string") {
    const config = await db.azureKeyVaultConfig.findUnique({
      where: { id: body.id },
    });
    if (!config) {
      return NextResponse.json(
        { error: "Azure Key Vault config not found" },
        { status: 404 },
      );
    }
    vaultUrl = config.vaultUrl;
    tenantId = config.tenantId;
    clientId = config.clientId;
    clientSecret = decrypt(config.clientSecret);
  } else {
    // Use inline credentials from the request body
    if (!body.vaultUrl || typeof body.vaultUrl !== "string") {
      return NextResponse.json({ error: "vaultUrl is required" }, { status: 400 });
    }
    if (!body.tenantId || typeof body.tenantId !== "string") {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }
    if (!body.clientId || typeof body.clientId !== "string") {
      return NextResponse.json({ error: "clientId is required" }, { status: 400 });
    }
    if (!body.clientSecret || typeof body.clientSecret !== "string") {
      return NextResponse.json({ error: "clientSecret is required" }, { status: 400 });
    }
    vaultUrl = body.vaultUrl;
    tenantId = body.tenantId;
    clientId = body.clientId;
    clientSecret = body.clientSecret;
  }

  try {
    // Step 1: Obtain an access token from Azure AD
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const tokenBody = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: `${vaultUrl.replace(/\/$/, "")}/.default`,
    });

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => "Unknown error");
      return NextResponse.json(
        {
          success: false,
          error: "Failed to obtain Azure AD token",
          details: errBody,
        },
        { status: 400 },
      );
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Step 2: List secrets to verify vault access
    const secretsUrl = `${vaultUrl.replace(/\/$/, "")}/secrets?api-version=7.4&maxresults=1`;
    const secretsRes = await fetch(secretsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!secretsRes.ok) {
      const errBody = await secretsRes.text().catch(() => "Unknown error");
      return NextResponse.json(
        {
          success: false,
          error: "Connected to Azure AD but failed to access vault",
          details: errBody,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Successfully connected to Azure Key Vault",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: "Connection test failed", details: message },
      { status: 500 },
    );
  }
}
