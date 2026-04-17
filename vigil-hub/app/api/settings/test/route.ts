import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { assertExternalUrl, assertExternalHostname } from "@/lib/url-safety";

/**
 * POST /api/settings/test
 * Test notification channel connectivity. Used by setup wizard and settings page.
 *
 * Auth model:
 *  - Setup mode (no users exist yet): allowed unauthenticated, so the wizard can
 *    test SMTP/webhook settings before creating the admin account.
 *  - After setup: requires an admin session. Anything less is rejected.
 * SSRF: all outbound URLs are validated against loopback/RFC1918/link-local.
 */
export async function POST(req: NextRequest) {
  const userCount = await db.user.count();
  if (userCount > 0) {
    const session = await getSession(req);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if ((session.user as { role?: string }).role !== "admin") {
      return NextResponse.json(
        { error: "Forbidden: admin role required" },
        { status: 403 },
      );
    }
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { type } = body as Record<string, unknown>;

  try {
    switch (type) {
      case "smtp":
        return await testSmtp(body as Record<string, unknown>);
      case "teams":
        return await testWebhook(body as Record<string, unknown>, "teams");
      case "slack":
        return await testWebhook(body as Record<string, unknown>, "slack");
      case "discord":
        return await testWebhook(body as Record<string, unknown>, "discord");
      case "webhook":
        return await testWebhook(body as Record<string, unknown>, "webhook");
      case "telegram":
        return await testTelegram(body as Record<string, unknown>);
      case "twilio":
        return await testTwilio(body as Record<string, unknown>);
      default:
        return NextResponse.json({ error: `Unsupported type: ${type}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

async function testSmtp(cfg: Record<string, unknown>) {
  const host = cfg.smtp_host as string | undefined;
  const port = cfg.smtp_port as number | undefined;
  if (!host || !port) {
    return NextResponse.json({ error: "SMTP requires host and port" }, { status: 400 });
  }
  await assertExternalHostname(host);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: cfg.smtp_user
      ? { user: cfg.smtp_user as string, pass: cfg.smtp_pass as string }
      : undefined,
    // Test endpoint tolerates self-signed certs (relay-mode). Production alert
    // path uses the stored channel config, not this handler.
    tls: { rejectUnauthorized: false },
  });
  await transporter.verify();
  return NextResponse.json({ success: true, message: "SMTP connection verified" });
}

async function testWebhook(
  cfg: Record<string, unknown>,
  kind: "teams" | "slack" | "discord" | "webhook",
) {
  const urlKey = kind === "webhook" ? "webhook_url" : `${kind}_webhook`;
  const url = cfg[urlKey] as string | undefined;
  if (!url) {
    return NextResponse.json({ error: `${kind} requires ${urlKey}` }, { status: 400 });
  }
  await assertExternalUrl(url);

  const payload =
    kind === "teams"
      ? {
          "@type": "MessageCard",
          "@context": "http://schema.org/extensions",
          summary: "Vigil Test",
          title: "Vigil – test notification",
          text: "Your Microsoft Teams integration is working.",
        }
      : kind === "slack"
        ? { text: "Vigil – test notification. Your Slack integration is working." }
        : kind === "discord"
          ? {
              content: "Vigil – test notification.",
              embeds: [{ title: "Test", description: "Discord integration OK." }],
            }
          : { source: "vigil", type: "test", timestamp: new Date().toISOString() };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return NextResponse.json(
      { success: false, error: `${kind} returned ${res.status}` },
      { status: 400 },
    );
  }
  return NextResponse.json({ success: true, message: `Test sent to ${kind}` });
}

async function testTelegram(cfg: Record<string, unknown>) {
  const token = cfg.telegram_token as string | undefined;
  const chatId = cfg.telegram_chat_id as string | undefined;
  if (!token || !chatId) {
    return NextResponse.json(
      { error: "Telegram requires telegram_token and telegram_chat_id" },
      { status: 400 },
    );
  }
  // api.telegram.org is a fixed external endpoint — no SSRF vector.
  const res = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Vigil – test notification. Telegram integration works.",
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    return NextResponse.json(
      { success: false, error: `Telegram returned ${res.status}` },
      { status: 400 },
    );
  }
  return NextResponse.json({ success: true, message: "Test sent to Telegram" });
}

async function testTwilio(cfg: Record<string, unknown>) {
  const sid = cfg.twilio_sid as string | undefined;
  const token = cfg.twilio_token as string | undefined;
  const from = cfg.twilio_from as string | undefined;
  const to = cfg.twilio_to as string | undefined;
  if (!sid || !token || !from || !to) {
    return NextResponse.json(
      { error: "Twilio requires twilio_sid, twilio_token, twilio_from, twilio_to" },
      { status: 400 },
    );
  }
  const creds = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: from,
        To: to,
        Body: "Vigil – test notification. Twilio integration works.",
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    return NextResponse.json(
      { success: false, error: `Twilio returned ${res.status}` },
      { status: 400 },
    );
  }
  return NextResponse.json({ success: true, message: "Test SMS sent via Twilio" });
}
