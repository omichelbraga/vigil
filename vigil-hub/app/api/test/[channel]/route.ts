import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireAdmin } from "@/lib/authz";
import { assertExternalUrl, assertExternalHostname } from "@/lib/url-safety";

const VALID_CHANNELS = [
  "smtp",
  "slack",
  "teams",
  "discord",
  "telegram",
  "twilio",
  "generic",
];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { channel } = await params;
  if (!VALID_CHANNELS.includes(channel)) {
    return NextResponse.json(
      { error: `Invalid channel. Must be one of: ${VALID_CHANNELS.join(", ")}` },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    switch (channel) {
      case "smtp":
        return await testSmtp(body);
      case "slack":
        return await testSlack(body);
      case "teams":
        return await testTeams(body);
      case "discord":
        return await testDiscord(body);
      case "telegram":
        return await testTelegram(body);
      case "twilio":
        return await testTwilio(body);
      case "generic":
        return await testGenericWebhook(body);
      default:
        return NextResponse.json({ error: "Unsupported channel" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: `Test failed: ${message}` },
      { status: 500 },
    );
  }
}

async function testSmtp(config: Record<string, unknown>) {
  if (!config.host || !config.port) {
    return NextResponse.json(
      { error: "SMTP requires host and port" },
      { status: 400 },
    );
  }
  await assertExternalHostname(config.host as string);

  const transporter = nodemailer.createTransport({
    host: config.host as string,
    port: config.port as number,
    secure: (config.port as number) === 465,
    // Only include auth if credentials provided (relay mode = no auth)
    auth: config.user
      ? { user: config.user as string, pass: config.pass as string }
      : undefined,
    // Allow self-signed certs on internal relays
    tls: { rejectUnauthorized: false },
  });

  // If a to address is provided, send a real test email
  // Otherwise just verify the connection (relay test)
  if (config.to) {
    await transporter.sendMail({
      from: (config.from as string) || `vigil@${config.host}`,
      to: config.to as string,
      subject: "Vigil - Test Notification",
      text: "This is a test notification from Vigil monitoring system.",
      html: "<p><strong>Vigil</strong> - This is a test notification from Vigil monitoring system.</p>",
    });
    return NextResponse.json({ success: true, message: "Test email sent" });
  } else {
    // Verify connection without sending — works for relay mode
    await transporter.verify();
    return NextResponse.json({ success: true, message: "SMTP connection verified" });
  }
}

async function testSlack(config: Record<string, unknown>) {
  if (!config.webhookUrl || typeof config.webhookUrl !== "string") {
    return NextResponse.json(
      { error: "Slack requires a webhookUrl" },
      { status: 400 },
    );
  }
  await assertExternalUrl(config.webhookUrl);

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: ":white_check_mark: Vigil - Test notification. Your Slack integration is working.",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    return NextResponse.json(
      { success: false, error: `Slack returned ${res.status}: ${errText}` },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, message: "Test message sent to Slack" });
}

async function testTeams(config: Record<string, unknown>) {
  if (!config.webhookUrl || typeof config.webhookUrl !== "string") {
    return NextResponse.json(
      { error: "Teams requires a webhookUrl" },
      { status: 400 },
    );
  }
  await assertExternalUrl(config.webhookUrl);

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      summary: "Vigil Test Notification",
      themeColor: "00c853",
      title: "Vigil - Test Notification",
      sections: [
        {
          activityTitle: "Test",
          facts: [{ name: "Status", value: "Connected" }],
          text: "Your Microsoft Teams integration is working.",
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    return NextResponse.json(
      { success: false, error: `Teams returned ${res.status}: ${errText}` },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, message: "Test message sent to Teams" });
}

async function testDiscord(config: Record<string, unknown>) {
  if (!config.webhookUrl || typeof config.webhookUrl !== "string") {
    return NextResponse.json(
      { error: "Discord requires a webhookUrl" },
      { status: 400 },
    );
  }
  await assertExternalUrl(config.webhookUrl);

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "**Vigil** - Test notification. Your Discord integration is working.",
      embeds: [
        {
          title: "Test Notification",
          description: "Your Discord integration is configured correctly.",
          color: 0x00c853,
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    return NextResponse.json(
      { success: false, error: `Discord returned ${res.status}: ${errText}` },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, message: "Test message sent to Discord" });
}

async function testTelegram(config: Record<string, unknown>) {
  if (
    !config.botToken ||
    typeof config.botToken !== "string" ||
    !config.chatId
  ) {
    return NextResponse.json(
      { error: "Telegram requires botToken and chatId" },
      { status: 400 },
    );
  }

  const res = await fetch(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: "✅ *Vigil* \\- Test notification\\. Your Telegram integration is working\\.",
        parse_mode: "MarkdownV2",
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    return NextResponse.json(
      { success: false, error: `Telegram returned ${res.status}: ${errText}` },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, message: "Test message sent to Telegram" });
}

async function testTwilio(config: Record<string, unknown>) {
  if (
    !config.accountSid ||
    !config.authToken ||
    !config.from ||
    !config.to
  ) {
    return NextResponse.json(
      { error: "Twilio requires accountSid, authToken, from, and to" },
      { status: 400 },
    );
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const credentials = Buffer.from(
    `${config.accountSid}:${config.authToken}`,
  ).toString("base64");

  const body = new URLSearchParams({
    From: config.from as string,
    To: config.to as string,
    Body: "Vigil - Test notification. Your Twilio SMS integration is working.",
  });

  const res = await fetch(twilioUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    return NextResponse.json(
      { success: false, error: `Twilio returned ${res.status}: ${errText}` },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, message: "Test SMS sent via Twilio" });
}

async function testGenericWebhook(config: Record<string, unknown>) {
  if (!config.url || typeof config.url !== "string") {
    return NextResponse.json(
      { error: "Generic webhook requires a url" },
      { status: 400 },
    );
  }
  await assertExternalUrl(config.url);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.headers && typeof config.headers === "object") {
    Object.assign(headers, config.headers);
  }

  const payload = config.payload ?? {
    source: "vigil",
    type: "test",
    message: "Test notification from Vigil monitoring system.",
    timestamp: new Date().toISOString(),
  };

  const method = (typeof config.method === "string" && ["POST", "PUT"].includes(config.method.toUpperCase()))
    ? config.method.toUpperCase()
    : "POST";

  const res = await fetch(config.url, {
    method,
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    return NextResponse.json(
      { success: false, error: `Webhook returned ${res.status}: ${errText}` },
      { status: 400 },
    );
  }

  return NextResponse.json({
    success: true,
    message: `Test webhook sent (${res.status})`,
  });
}
