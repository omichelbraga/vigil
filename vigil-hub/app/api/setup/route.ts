import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { encrypt } from "@/lib/encryption";

/**
 * POST /api/setup
 * First-run setup: creates admin account, saves SMTP + branding config.
 * Only works when no users exist yet.
 */
export async function POST(req: NextRequest) {
  // Guard: only allowed when no users exist
  const userCount = await db.user.count();
  if (userCount > 0) {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    admin_email,
    admin_password,
    smtp_host,
    smtp_port,
    smtp_user,
    smtp_pass,
    smtp_from,
    company_name,
    primary_color,
  } = body as Record<string, unknown>;

  if (!admin_email || !admin_password) {
    return NextResponse.json({ error: "Admin email and password are required" }, { status: 400 });
  }

  try {
    // Create admin user via Better Auth
    await auth.api.signUpEmail({
      body: {
        email: admin_email as string,
        password: admin_password as string,
        name: "Admin",
        role: "admin",
      },
    });

    // Save branding config (upsert singleton)
    await db.brandingConfig.upsert({
      where: { id: "singleton" },
      update: {
        companyName: (company_name as string) || "Vigil",
        primaryColor: (primary_color as string) || "#10b981",
      },
      create: {
        id: "singleton",
        companyName: (company_name as string) || "Vigil",
        primaryColor: (primary_color as string) || "#10b981",
      },
    });

    // Save SMTP config as an AlertChannel if host provided
    if (smtp_host) {
      const smtpConfig = {
        host: smtp_host as string,
        port: (smtp_port as number) || 25,
        user: smtp_user ? encrypt(smtp_user as string) : "",
        pass: smtp_pass ? encrypt(smtp_pass as string) : "",
        from: (smtp_from as string) || `vigil@${smtp_host}`,
        secure: (smtp_port as number) === 465,
      };

      await db.alertChannel.upsert({
        where: { id: "smtp-default" },
        update: {
          name: "Email (SMTP)",
          type: "smtp",
          config: smtpConfig,
          enabled: true,
        },
        create: {
          id: "smtp-default",
          name: "Email (SMTP)",
          type: "smtp",
          config: smtpConfig,
          enabled: true,
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
