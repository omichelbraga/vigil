import { db } from "./db";

interface CheckContext {
  checkId: string;
  checkName: string;
  agentId: string;
  agentName: string;
  status: string;
  message?: string | null;
}

/**
 * Called after every check result is saved.
 * Fires alert on first Critical/Warning, resolves when back to OK.
 * No rules required — works out of the box.
 */
export async function processAlert(ctx: CheckContext) {
  const { checkId, checkName, agentId, agentName, status, message } = ctx;

  // Find open incident for this check
  const openIncident = await db.alertHistory.findFirst({
    where: { checkId, status: "fired" },
    orderBy: { firedAt: "desc" },
  });

  if ((status === "critical" || status === "warning") && !openIncident) {
    // NEW INCIDENT — fire alert
    const incident = await db.alertHistory.create({
      data: {
        ruleId: await getOrCreateDefaultRule(),
        checkId,
        agentId,
        status: "fired",
        message: message || `${checkName} is ${status}`,
        channel: "auto",
        delivered: false,
      },
    });

    await sendNotification({
      type: "alert",
      title: `🚨 ${checkName} is ${status.toUpperCase()}`,
      body: message || `${checkName} on agent ${agentName} is ${status}`,
      agentName,
      checkName,
      status,
    });

    await db.alertHistory.update({
      where: { id: incident.id },
      data: { delivered: true },
    });

  } else if (status === "ok" && openIncident) {
    // RECOVERED — resolve incident
    await db.alertHistory.update({
      where: { id: openIncident.id },
      data: { status: "resolved", resolvedAt: new Date() },
    });

    await sendNotification({
      type: "resolved",
      title: `✅ ${checkName} recovered`,
      body: `${checkName} on agent ${agentName} is back to normal.`,
      agentName,
      checkName,
      status,
    });
  }
}

interface Notification {
  type: "alert" | "resolved";
  title: string;
  body: string;
  agentName: string;
  checkName: string;
  status: string;
}

async function sendNotification(n: Notification) {
  const channels = await db.alertChannel.findMany({
    where: { enabled: true },
  });

  for (const ch of channels) {
    try {
      const config = ch.config as Record<string, unknown>;
      switch (ch.type) {
        case "teams":
          await sendTeams(config.url as string, n);
          break;
        case "slack":
          await sendSlack(config.url as string, n);
          break;
        case "discord":
          await sendDiscord(config.url as string, n);
          break;
        case "telegram":
          await sendTelegram(config.token as string, config.chat_id as string, n);
          break;
        case "webhook":
          await sendWebhook(config.url as string, n);
          break;
        case "smtp":
          // SMTP alert sending — basic implementation
          await sendSmtpAlert(config, n);
          break;
      }
    } catch (err) {
      console.error(`Alert delivery failed for channel ${ch.name}:`, err);
    }
  }
}

async function sendTeams(webhookUrl: string, n: Notification) {
  if (!webhookUrl) return;
  const color = n.type === "alert" ? "attention" : "good";
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          version: "1.2",
          body: [
            { type: "TextBlock", size: "Large", weight: "Bolder", text: n.title, color },
            { type: "TextBlock", text: n.body, wrap: true },
            { type: "FactSet", facts: [
              { title: "Agent", value: n.agentName },
              { title: "Check", value: n.checkName },
              { title: "Status", value: n.status.toUpperCase() },
              { title: "Time", value: new Date().toISOString() },
            ]},
          ],
        },
      }],
    }),
  });
}

async function sendSlack(webhookUrl: string, n: Notification) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${n.title}\n${n.body}`,
      attachments: [{
        color: n.type === "alert" ? "danger" : "good",
        fields: [
          { title: "Agent", value: n.agentName, short: true },
          { title: "Check", value: n.checkName, short: true },
        ],
      }],
    }),
  });
}

async function sendDiscord(webhookUrl: string, n: Notification) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: n.title,
        description: n.body,
        color: n.type === "alert" ? 0xff0000 : 0x00ff00,
        fields: [
          { name: "Agent", value: n.agentName, inline: true },
          { name: "Check", value: n.checkName, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}

async function sendTelegram(token: string, chatId: string, n: Notification) {
  if (!token || !chatId) return;
  const text = `${n.title}\n\n${n.body}\n\nAgent: ${n.agentName}\nCheck: ${n.checkName}`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function sendWebhook(url: string, n: Notification) {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...n, timestamp: new Date().toISOString() }),
  });
}

async function sendSmtpAlert(config: Record<string, unknown>, n: Notification) {
  // Lazy import to avoid loading nodemailer on every request
  const nodemailer = await import("nodemailer");
  const host = config.host as string;
  if (!host) return;

  const transporter = nodemailer.default.createTransport({
    host,
    port: (config.port as number) || 25,
    secure: config.secure === true,
    auth: config.user ? { user: config.user as string, pass: config.pass as string } : undefined,
    tls: { rejectUnauthorized: false },
  });

  const from = (config.from as string) || `vigil@${host}`;
  const to = (config.alert_to as string) || from;

  await transporter.sendMail({
    from,
    to,
    subject: n.title,
    text: `${n.title}\n\n${n.body}\n\nAgent: ${n.agentName}\nCheck: ${n.checkName}\nTime: ${new Date().toISOString()}`,
  });
}

// Creates a singleton default alert rule if none exists
let defaultRuleId: string | null = null;
async function getOrCreateDefaultRule(): Promise<string> {
  if (defaultRuleId) return defaultRuleId;

  const existing = await db.alertRule.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) {
    defaultRuleId = existing.id;
    return existing.id;
  }

  // Need a channel to attach the rule to — find any or create placeholder
  let channel = await db.alertChannel.findFirst({ where: { enabled: true } });
  if (!channel) {
    channel = await db.alertChannel.create({
      data: { id: "default", name: "Default", type: "none", config: {}, enabled: false },
    });
  }

  const rule = await db.alertRule.create({
    data: {
      name: "Default Alert Rule",
      channelId: channel.id,
      condition: { status: "critical", consecutiveCount: 1 },
      enabled: true,
    },
  });

  defaultRuleId = rule.id;
  return rule.id;
}
