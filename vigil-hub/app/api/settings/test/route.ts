import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";

/**
 * POST /api/settings/test
 * Test notification channel connectivity. Used by setup wizard and settings page.
 * No session required during setup (called before login completes).
 */
export async function POST(req: NextRequest) {
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
      default:
        return NextResponse.json({ error: `Unsupported type: ${type}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

async function testSmtp(config: Record<string, unknown>) {
  const host = config.smtp_host as string;
  const port = (config.smtp_port as number) || 25;
  const user = config.smtp_user as string | undefined;
  const pass = config.smtp_pass as string | undefined;

  if (!host) {
    return NextResponse.json({ error: "SMTP host is required" }, { status: 400 });
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    // Relay mode: no auth if no credentials provided
    auth: user ? { user, pass: pass || "" } : undefined,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 8000,
    greetingTimeout: 5000,
  });

  await transporter.verify();

  return NextResponse.json({ success: true, message: "SMTP connection verified" });
}

async function testWebhook(config: Record<string, unknown>, type: string) {
  const url = (config.webhook_url || config.url) as string;
  if (!url) {
    return NextResponse.json({ error: "Webhook URL is required" }, { status: 400 });
  }

  let body: string;
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  if (type === "teams") {
    // Teams Adaptive Card format
    body = JSON.stringify({
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          version: "1.2",
          body: [{ type: "TextBlock", text: "✅ Vigil — Test notification. Teams webhook is working." }]
        }
      }]
    });
  } else if (type === "slack") {
    body = JSON.stringify({ text: "✅ Vigil — Test notification. Slack webhook is working." });
  } else if (type === "discord") {
    body = JSON.stringify({ content: "✅ Vigil — Test notification. Discord webhook is working." });
  } else {
    body = JSON.stringify({ text: "✅ Vigil — Test notification.", source: "vigil" });
  }

  const res = await fetch(url, { method: "POST", headers, body });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { success: false, error: `Webhook returned ${res.status}: ${text.slice(0, 200)}` },
      { status: 502 }
    );
  }

  return NextResponse.json({ success: true, message: "Webhook delivered successfully" });
}
