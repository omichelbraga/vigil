import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { decrypt } from "@/lib/encryption";

type Role = "admin" | "editor" | "viewer";
const VALID_ROLES: readonly Role[] = ["admin", "editor", "viewer"] as const;

function isRole(v: unknown): v is Role {
  return typeof v === "string" && (VALID_ROLES as readonly string[]).includes(v);
}

/**
 * Generates a strong 24-character random password using a hex-ish alphabet.
 * Uses Web Crypto (available in the Next.js runtime).
 */
function generateTempPassword(): string {
  const alphabet =
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function tryDecrypt(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) return "";
  try {
    return decrypt(v);
  } catch {
    return v;
  }
}

interface SmtpChannelConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

async function loadSmtpConfig(): Promise<SmtpChannelConfig | null> {
  const channel = await db.alertChannel.findFirst({
    where: { type: "smtp", enabled: true },
  });
  if (!channel) return null;
  const cfg = channel.config as Record<string, unknown>;
  const host = typeof cfg.host === "string" ? cfg.host : "";
  if (!host) return null;
  const portRaw = cfg.port;
  const port =
    typeof portRaw === "number"
      ? portRaw
      : typeof portRaw === "string"
        ? parseInt(portRaw, 10)
        : 587;
  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: typeof cfg.secure === "boolean" ? cfg.secure : port === 465,
    user: tryDecrypt(cfg.user),
    pass: tryDecrypt(cfg.pass),
    from: typeof cfg.from === "string" && cfg.from.length > 0 ? cfg.from : "",
  };
}

async function sendInviteEmail(
  smtp: SmtpChannelConfig,
  to: string,
  displayName: string,
  tempPassword: string,
  baseUrl: string,
): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth:
      smtp.user && smtp.pass
        ? { user: smtp.user, pass: smtp.pass }
        : undefined,
  });

  const loginUrl = `${baseUrl.replace(/\/$/, "")}/login`;
  const subject = "You're invited to Vigil";
  const text = [
    `Hi ${displayName},`,
    ``,
    `An administrator invited you to Vigil monitoring.`,
    ``,
    `Sign in at: ${loginUrl}`,
    `Email:    ${to}`,
    `Password: ${tempPassword}`,
    ``,
    `Please change your password after your first sign-in.`,
  ].join("\n");

  const safeName = displayName.replace(/[<>]/g, "");
  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;padding:24px;">
  <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;margin:auto;">
    <tr><td style="background:#10b981;padding:20px 32px;border-radius:8px 8px 0 0;">
      <h1 style="margin:0;color:#fff;font-size:20px;">You're invited to Vigil</h1>
    </td></tr>
    <tr><td style="padding:32px;color:#333;">
      <p>Hi ${safeName},</p>
      <p>An administrator invited you to Vigil monitoring.</p>
      <p style="background:#f9f9f9;padding:16px;border-radius:6px;border-left:4px solid #10b981;">
        <strong>Sign in:</strong> <a href="${loginUrl}">${loginUrl}</a><br />
        <strong>Email:</strong> ${to}<br />
        <strong>Temporary password:</strong> <code style="background:#eef;padding:2px 6px;border-radius:3px;">${tempPassword}</code>
      </p>
      <p>Please change your password after your first sign-in.</p>
    </td></tr>
  </table>
</body></html>`;

  await transporter.sendMail({
    from: smtp.from || `no-reply@${smtp.host}`,
    to,
    subject,
    text,
    html,
  });
}

/**
 * POST /api/admin/users/invite
 * Body: { email, name?, role, sendEmail }
 * - Creates a Better Auth user with a strong random password.
 * - Forces the requested role after signup.
 * - If sendEmail=true, attempts SMTP delivery (best-effort) and still returns
 *   the tempPassword if no SMTP channel is configured.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await requireAdmin(req);
  if (!authz.ok) return authz.response;

  const body = (await req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const role: Role = isRole(body.role) ? body.role : "viewer";
  const displayName =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : email.split("@")[0];
  const sendEmail = body.sendEmail === true;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "User already exists" }, { status: 409 });
  }

  const tempPassword = generateTempPassword();

  try {
    await auth.api.signUpEmail({
      body: {
        email,
        password: tempPassword,
        name: displayName,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Signup failed: ${message}` },
      { status: 500 },
    );
  }

  // Better Auth's typed signUpEmail doesn't accept custom fields, so force the
  // role afterwards — same pattern used in /api/setup and /api/users/invite.
  await db.user.updateMany({ where: { email }, data: { role } });

  const created = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
    },
  });
  if (!created) {
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 },
    );
  }

  // Best-effort email delivery
  let emailSent = false;
  let emailError: string | null = null;
  if (sendEmail) {
    try {
      const smtp = await loadSmtpConfig();
      if (smtp) {
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL ||
          process.env.BETTER_AUTH_URL ||
          "http://localhost:3000";
        await sendInviteEmail(smtp, email, displayName, tempPassword, baseUrl);
        emailSent = true;
      }
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err);
    }
  }

  await audit(req, authz.user.id, "user.invite", {
    entityId: created.id,
    metadata: { email, role, sendEmail, emailSent },
  });

  // If sendEmail was requested AND email was delivered, never leak the password.
  const revealPassword = !sendEmail || !emailSent;

  return NextResponse.json(
    {
      success: true,
      user: created,
      emailSent,
      emailError,
      ...(revealPassword ? { tempPassword } : {}),
    },
    { status: 201 },
  );
}
