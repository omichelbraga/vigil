import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { encrypt } from "@/lib/encryption";
import { audit } from "@/lib/audit";

/**
 * POST /api/setup
 * First-run setup: creates admin account, saves SMTP + branding config.
 * Only works when no users exist yet.
 */
// Module-level mutex: serialises /api/setup POSTs so two concurrent requests
// can't both see userCount===0 and create two admins. Single-process only;
// if you run multiple Hub replicas, add a DB-level advisory lock.
let setupInFlight: Promise<unknown> | null = null;

export async function POST(req: NextRequest) {
  if (setupInFlight) {
    return NextResponse.json({ error: "Setup already in progress" }, { status: 409 });
  }

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
    const work = (async () => {
      // Re-check inside the serialised block so two racing requests both see
      // the winner's user row on the second check.
      const recount = await db.user.count();
      if (recount > 0) {
        throw new Error("Setup already completed");
      }

      // Create admin user via Better Auth (role is force-set below — Better
      // Auth's typed signUpEmail doesn't accept custom fields in the body).
      await auth.api.signUpEmail({
        body: {
          email: admin_email as string,
          password: admin_password as string,
          name: "Admin",
        },
      });
    })();
    setupInFlight = work;
    await work;

    // Better Auth may not persist custom roles — force-set admin role in DB
    await db.user.updateMany({
      where: { email: admin_email as string },
      data: { role: "admin" },
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

    // Look up the newly-created admin for the audit trail — Better Auth returns
    // a session, not the persisted user row, so we query by email here.
    const createdAdmin = await db.user.findUnique({
      where: { email: admin_email as string },
      select: { id: true },
    });

    await audit(req, createdAdmin?.id ?? null, "setup.complete", {
      entityType: "setup",
      entityId: createdAdmin?.id,
      metadata: { adminEmail: admin_email as string },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Setup failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    // "Setup already completed" is an expected race loser — return 409 not 500.
    const status = message === "Setup already completed" ? 409 : 500;
    return NextResponse.json(
      { error: status === 409 ? message : "Setup failed" },
      { status },
    );
  } finally {
    setupInFlight = null;
  }
}
