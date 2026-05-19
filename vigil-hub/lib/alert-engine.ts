import { db } from "./db";
import { recordDelivery } from "./integrations";

/**
 * Lazy accessor for the SSE broadcast helper. Loaded on-demand so the
 * alert-engine ↔ ws-server module pair doesn't share a static import cycle.
 * ws-server imports this file at top level; if we imported ws-server back at
 * top level, the bindings would still resolve (they're only called after
 * init), but the lazy form removes any doubt and keeps initialization clean.
 */
let cachedBroadcast: ((event: string, data: unknown) => void) | null = null;
async function emitSSE(event: string, data: unknown): Promise<void> {
  try {
    if (!cachedBroadcast) {
      const mod: { broadcastSSE?: (event: string, data: unknown) => void } =
        await import("./ws-server");
      cachedBroadcast = mod.broadcastSSE ?? null;
    }
    cachedBroadcast?.(event, data);
  } catch (err) {
    console.warn("[alert] SSE broadcast failed:", err);
  }
}

interface CheckContext {
  checkId: string;
  checkName: string;
  agentId: string;
  agentName: string;
  status: string;
  message?: string | null;
  skipRecovery?: boolean; // If true, no notification sent when check resolves to OK
}

/**
 * Called after every check result is saved.
 * Fires alert on first Critical/Warning, resolves when back to OK.
 * No rules required — works out of the box.
 *
 * Dual-writes to both the new `Incident` table and the legacy `AlertHistory`
 * table. Readers can prefer `Incident`; `AlertHistory` is retained for
 * backwards-compat with anything still reading it.
 */
export async function processAlert(ctx: CheckContext) {
  const { checkId, checkName, agentId, agentName, status, message, skipRecovery } = ctx;

  // Find any open incident for this check. Prefer the new Incident table, but
  // fall back to the legacy AlertHistory so we don't accidentally double-fire
  // during the dual-write migration period.
  const [openIncident, openAlertHistory] = await Promise.all([
    db.incident.findFirst({
      where: { checkId, status: "firing" },
      orderBy: { firedAt: "desc" },
    }),
    db.alertHistory.findFirst({
      where: { checkId, status: "fired" },
      orderBy: { firedAt: "desc" },
    }),
  ]);
  const hasOpen = Boolean(openIncident || openAlertHistory);

  if ((status === "critical" || status === "warning") && !hasOpen) {
    // NEW INCIDENT — write to both tables.
    const severity: "warning" | "critical" = status === "critical" ? "critical" : "warning";
    const title = `${checkName} is ${severity}`;
    const description = message || `${checkName} on agent ${agentName} is ${severity}`;

    // The Incident table enforces FKs on checkId/agentId. Legacy AlertHistory
    // did not, so we tolerate synthetic/unknown IDs by null-ing the Incident
    // checkId when it's not a real row. AgentId must resolve — if it doesn't,
    // we skip the Incident write (AlertHistory still captures the event).
    const [checkExists, agentExists] = await Promise.all([
      checkId ? db.check.findUnique({ where: { id: checkId }, select: { id: true } }) : null,
      db.agent.findUnique({ where: { id: agentId }, select: { id: true } }),
    ]);

    const incidentRow = agentExists
      ? await db.incident.create({
          data: {
            checkId: checkExists ? checkId : null,
            agentId,
            severity,
            status: "firing",
            title,
            description,
            metadata: { checkId, checkName, agentName },
          },
          select: { id: true, firedAt: true },
        })
      : null;

    const legacyAlert = await db.alertHistory.create({
      data: {
        ruleId: await getOrCreateDefaultRule(),
        checkId,
        agentId,
        status: "fired",
        message: description,
        channel: "auto",
        delivered: false,
      },
    });

    let delivered = false;
    try {
      await sendNotification({
        type: "alert",
        title: `${checkName} is ${severity.charAt(0).toUpperCase() + severity.slice(1)}`,
        body: description,
        agentName,
        checkName,
        status,
      });
      delivered = true;
    } catch (err) {
      console.error("Failed to send alert notification:", err);
    }

    await db.alertHistory.update({
      where: { id: legacyAlert.id },
      data: { delivered },
    });

    // Push to the live notifications tray. Payload is intentionally trimmed:
    // no raw channel config, no URLs, no secrets — just the display fields
    // the browser tray needs to classify + navigate.
    await emitSSE("incident_fired", {
      incidentId: incidentRow?.id ?? null,
      checkId,
      checkName,
      agentName,
      status,
      message: description,
      firedAt: (incidentRow?.firedAt ?? new Date()).toISOString(),
    });

  } else if (status === "ok" && hasOpen) {
    // RECOVERED — resolve incident in both tables.
    const resolvedAt = new Date();

    if (openIncident) {
      await db.incident.update({
        where: { id: openIncident.id },
        data: { status: "resolved", resolvedAt },
      });
    }
    if (openAlertHistory) {
      await db.alertHistory.update({
        where: { id: openAlertHistory.id },
        data: { status: "resolved", resolvedAt },
      });
    }

    // Only send recovery notification if not suppressed (e.g. cert monitors)
    if (!skipRecovery) {
      await sendNotification({
        type: "resolved",
        title: `${checkName} recovered`,
        body: `${checkName} on agent ${agentName} is back to normal.`,
        agentName,
        checkName,
        status,
      });
    }

    await emitSSE("incident_resolved", {
      incidentId: openIncident?.id ?? null,
      checkId,
      checkName,
      agentName,
      resolvedAt: resolvedAt.toISOString(),
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

function renderTemplate(template: string, n: Notification): string {
  const isRecovery = n.type === "resolved";
  const emoji = isRecovery ? "✅" : "🚨";
  const color = isRecovery ? "5763719" : "16729344";   // Discord int: green / orange-red
  const colorHex = isRecovery ? "#57F287" : "#FF6B00"; // hex for other uses
  const statusEmoji = isRecovery ? "🟢" : "🔴";

  return template
    .replace(/\{\{title\}\}/g, n.title)
    .replace(/\{\{body\}\}/g, n.body)
    .replace(/\{\{checkName\}\}/g, n.checkName)
    .replace(/\{\{agentName\}\}/g, n.agentName)
    .replace(/\{\{status\}\}/g, n.status)
    .replace(/\{\{type\}\}/g, n.type)
    .replace(/\{\{timestamp\}\}/g, new Date().toISOString())
    .replace(/\{\{emoji\}\}/g, emoji)
    .replace(/\{\{statusEmoji\}\}/g, statusEmoji)
    .replace(/\{\{color\}\}/g, color)
    .replace(/\{\{colorHex\}\}/g, colorHex);
}

function buildPayload(config: Record<string, unknown>, n: Notification, defaultPayload: unknown): unknown {
  const customPayload = config.custom_payload as string | undefined;
  if (!customPayload?.trim()) return defaultPayload;
  try {
    const rendered = renderTemplate(customPayload, n);
    return JSON.parse(rendered);
  } catch {
    console.warn("[alert] Custom payload is invalid JSON, using default");
    return defaultPayload;
  }
}

async function sendNotification(n: Notification) {
  const channels = await db.alertChannel.findMany({
    where: { enabled: true },
  });

  for (const ch of channels) {
    const config = ch.config as Record<string, unknown>;
    const start = Date.now();
    let httpStatus: number | null = null;
    let deliveryError: string | null = null;

    try {
      switch (ch.type) {
        case "teams":
          httpStatus = await sendTeams(config.url as string, n, config);
          break;
        case "slack":
          httpStatus = await sendSlack(config.url as string, n, config);
          break;
        case "discord":
          httpStatus = await sendDiscord(config.url as string, n, config);
          break;
        case "telegram":
          httpStatus = await sendTelegram(
            config.token as string,
            config.chat_id as string,
            n,
            config,
          );
          break;
        case "webhook":
          httpStatus = await sendWebhook(config.url as string, n, config);
          break;
        case "smtp":
          await sendSmtpAlert(config, n);
          break;
        default:
          continue;
      }
      console.log(`[alert] ✅ Delivered to ${ch.name} (${ch.type})`);
    } catch (err) {
      deliveryError = err instanceof Error ? err.message : String(err);
      console.error(`[alert] ❌ FAILED for ${ch.name} (${ch.type}):`, err);
    }

    // Record the attempt regardless of outcome — powers the "Recent deliveries"
    // log on /admin/integrations/[kind].
    await recordDelivery({
      channelId: ch.id,
      status: deliveryError ? "failed" : "success",
      title: n.title,
      httpStatus,
      lastError: deliveryError,
      latencyMs: Date.now() - start,
      attempts: 1,
    });
  }
}

async function sendTeams(
  webhookUrl: string,
  n: Notification,
  config: Record<string, unknown>,
): Promise<number | null> {
  if (!webhookUrl) return null;
  const color = n.type === "alert" ? "attention" : "good";
  const defaultPayload = {
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
  };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(config, n, defaultPayload)),
  });
  if (!res.ok) throw new Error(`Teams returned ${res.status}`);
  return res.status;
}

async function sendSlack(
  webhookUrl: string,
  n: Notification,
  config: Record<string, unknown>,
): Promise<number | null> {
  if (!webhookUrl) return null;
  const defaultPayload = {
    text: `${n.title}\n${n.body}`,
    attachments: [{
      color: n.type === "alert" ? "danger" : "good",
      fields: [
        { title: "Agent", value: n.agentName, short: true },
        { title: "Check", value: n.checkName, short: true },
      ],
    }],
  };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(config, n, defaultPayload)),
  });
  if (!res.ok) throw new Error(`Slack returned ${res.status}`);
  return res.status;
}

async function sendDiscord(
  webhookUrl: string,
  n: Notification,
  config: Record<string, unknown>,
): Promise<number | null> {
  if (!webhookUrl) return null;
  const defaultPayload = {
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
  };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(config, n, defaultPayload)),
  });
  if (!res.ok) throw new Error(`Discord returned ${res.status}`);
  return res.status;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegram(
  token: string,
  chatId: string,
  n: Notification,
  config: Record<string, unknown>,
): Promise<number | null> {
  if (!token || !chatId) return null;
  const customPayload = config.custom_payload as string | undefined;

  // For Telegram: render template but HTML-escape all variable values
  const safe = {
    ...n,
    title: escapeHtml(n.title),
    body: escapeHtml(n.body),
    agentName: escapeHtml(n.agentName),
    checkName: escapeHtml(n.checkName),
    status: escapeHtml(n.status),
  };

  const isRecovery = n.type === "resolved";
  const text = customPayload?.trim()
    ? renderTemplate(customPayload, { ...safe, type: n.type })
    : `${isRecovery ? "✅" : "🚨"} <b>${safe.title}</b>\n\n${safe.body}\n\n🖥 <b>Agent:</b> ${safe.agentName}\n🔍 <b>Check:</b> ${safe.checkName}\n${isRecovery ? "🟢" : "🔴"} <b>Status:</b> ${safe.status}`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram returned ${res.status}`);
  return res.status;
}

async function sendWebhook(
  url: string,
  n: Notification,
  config: Record<string, unknown>,
): Promise<number | null> {
  if (!url) return null;
  const defaultPayload = { ...n, timestamp: new Date().toISOString() };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(config, n, defaultPayload)),
  });
  if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
  return res.status;
}

async function sendSmtpAlert(config: Record<string, unknown>, n: Notification) {
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
  const isRecovery = n.type === "resolved";
  const accentColor = isRecovery ? "#22c55e" : "#ef4444";
  const badgeColor  = isRecovery ? "#dcfce7" : "#fee2e2";
  const badgeText   = isRecovery ? "#166534" : "#991b1b";
  const emoji       = isRecovery ? "✅" : "🚨";
  const statusLabel = n.status.toUpperCase();
  const now         = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "full", timeStyle: "short" });

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${n.title}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header bar -->
        <tr><td style="background:${accentColor};padding:4px 0;"></td></tr>

        <!-- Logo / Brand -->
        <tr><td style="padding:32px 40px 0;border-bottom:1px solid #f1f5f9;">
          <table width="100%"><tr>
            <td><span style="font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">⚡ Vigil</span>
            <span style="font-size:13px;color:#94a3b8;margin-left:8px;">Monitor</span></td>
            <td align="right"><span style="display:inline-block;background:${badgeColor};color:${badgeText};font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px;letter-spacing:0.5px;">${statusLabel}</span></td>
          </tr></table>
        </td></tr>

        <!-- Alert body -->
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 8px;font-size:26px;">${emoji}</p>
          <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0f172a;line-height:1.3;">${n.title}</h1>
          <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.6;">${n.body}</p>

          <!-- Details card -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tr style="border-bottom:1px solid #e2e8f0;">
              <td style="padding:14px 20px;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;width:120px;">Agent</td>
              <td style="padding:14px 20px;font-size:14px;font-weight:600;color:#0f172a;">${n.agentName}</td>
            </tr>
            <tr style="border-bottom:1px solid #e2e8f0;">
              <td style="padding:14px 20px;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Check</td>
              <td style="padding:14px 20px;font-size:14px;font-weight:600;color:#0f172a;">${n.checkName}</td>
            </tr>
            <tr style="border-bottom:1px solid #e2e8f0;">
              <td style="padding:14px 20px;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Status</td>
              <td style="padding:14px 20px;font-size:14px;font-weight:600;color:${accentColor};">${statusLabel}</td>
            </tr>
            <tr>
              <td style="padding:14px 20px;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Time</td>
              <td style="padding:14px 20px;font-size:14px;color:#0f172a;">${now}</td>
            </tr>
          </table>

          <!-- CTA -->
          <div style="margin-top:28px;text-align:center;">
            <a href="${process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000"}" style="display:inline-block;background:${accentColor};color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;letter-spacing:0.2px;">View in Vigil →</a>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 40px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">⚡ Vigil Monitor &nbsp;•&nbsp; Automated alert &nbsp;•&nbsp; Do not reply</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from,
    to,
    subject: `${emoji} ${n.title}`,
    text: `${n.title}\n\n${n.body}\n\nAgent: ${n.agentName}\nCheck: ${n.checkName}\nStatus: ${statusLabel}\nTime: ${now}`,
    html,
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

/** Fire an agent-offline notification directly to all enabled channels */
export async function sendAgentOfflineAlert(agentName: string): Promise<void> {
  await sendNotification({
    type: "alert",
    title: `${agentName} is offline`,
    body: `Agent on host "${agentName}" is unreachable. The computer may be powered off or the Vigil agent service may have stopped.`,
    agentName,
    checkName: "Agent Heartbeat",
    status: "offline",
  });
}

/** Fire an agent-back-online recovery notification */
export async function sendAgentOnlineAlert(agentName: string): Promise<void> {
  await sendNotification({
    type: "resolved",
    title: `${agentName} is back online`,
    body: `Agent on host "${agentName}" has reconnected and is reporting normally.`,
    agentName,
    checkName: "Agent Heartbeat",
    status: "online",
  });
}
