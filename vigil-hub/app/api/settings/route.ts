import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import type { Prisma } from "@prisma/client";

type JsonObj = Prisma.InputJsonValue;

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Load all settings from AppConfig + BrandingConfig + AlertChannels
  const [appConfigs, branding, channels] = await Promise.all([
    db.appConfig.findMany(),
    db.brandingConfig.findFirst(),
    db.alertChannel.findMany({ select: { id: true, name: true, type: true, enabled: true, config: true } }),
  ]);

  const config: Record<string, unknown> = {};
  for (const c of appConfigs) config[c.key] = c.value;

  // Extract notification webhooks from channels
  const smtpChannel = channels.find((c) => c.type === "smtp");
  const slackChannel = channels.find((c) => c.type === "slack");
  const teamsChannel = channels.find((c) => c.type === "teams");
  const discordChannel = channels.find((c) => c.type === "discord");
  const telegramChannel = channels.find((c) => c.type === "telegram");

  return NextResponse.json({
    ...config,
    company_name: branding?.companyName ?? "Vigil",
    primary_color: branding?.primaryColor ?? "#10b981",
    logo_url: branding?.logoUrl ?? null,
    smtp_host: smtpChannel ? (smtpChannel.config as Record<string, unknown>)?.host ?? "" : "",
    smtp_port: smtpChannel ? (smtpChannel.config as Record<string, unknown>)?.port ?? 25 : 25,
    smtp_user: smtpChannel ? (smtpChannel.config as Record<string, unknown>)?.user ?? "" : "",
    smtp_from: smtpChannel ? (smtpChannel.config as Record<string, unknown>)?.from ?? "" : "",
    smtp_alert_to: smtpChannel ? (smtpChannel.config as Record<string, unknown>)?.alert_to ?? "" : "",
    smtp_enabled: smtpChannel ? smtpChannel.enabled : false,
    slack_webhook: slackChannel ? (slackChannel.config as Record<string, unknown>)?.url ?? "" : "",
    slack_custom_payload: slackChannel ? (slackChannel.config as Record<string, unknown>)?.custom_payload ?? "" : "",
    teams_webhook: teamsChannel ? (teamsChannel.config as Record<string, unknown>)?.url ?? "" : "",
    teams_custom_payload: teamsChannel ? (teamsChannel.config as Record<string, unknown>)?.custom_payload ?? "" : "",
    discord_webhook: discordChannel ? (discordChannel.config as Record<string, unknown>)?.url ?? "" : "",
    discord_custom_payload: discordChannel ? (discordChannel.config as Record<string, unknown>)?.custom_payload ?? "" : "",
    telegram_token: telegramChannel ? (telegramChannel.config as Record<string, unknown>)?.token ?? "" : "",
    telegram_chat_id: telegramChannel ? (telegramChannel.config as Record<string, unknown>)?.chat_id ?? "" : "",
    telegram_custom_payload: telegramChannel ? (telegramChannel.config as Record<string, unknown>)?.custom_payload ?? "" : "",
    webhook_url: (channels.find(c => c.type === "webhook")?.config as Record<string, unknown>)?.url ?? "",
    webhook_custom_payload: (channels.find(c => c.type === "webhook")?.config as Record<string, unknown>)?.custom_payload ?? "",
  });
}

export async function PUT(req: NextRequest) {
  return POST_handler(req);
}

export async function POST(req: NextRequest) {
  return POST_handler(req);
}

async function POST_handler(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const { section, ...data } = body as Record<string, unknown>;

  try {
    switch (section) {
      case "general":
        await upsertAppConfig("site_name", String(data.site_name ?? "Vigil"));
        await upsertAppConfig("alert_from_email", String(data.alert_from_email ?? ""));
        break;

      case "branding":
        await db.brandingConfig.upsert({
          where: { id: "singleton" },
          update: {
            companyName: String(data.company_name ?? "Vigil"),
            primaryColor: String(data.primary_color ?? "#10b981"),
            ...(data.logo_url ? { logoUrl: String(data.logo_url) } : {}),
          },
          create: {
            id: "singleton",
            companyName: String(data.company_name ?? "Vigil"),
            primaryColor: String(data.primary_color ?? "#10b981"),
          },
        });
        break;

      case "smtp": {
        const smtpEnabled = data.smtp_enabled === true;
        await db.alertChannel.upsert({
          where: { id: "smtp-default" },
          update: {
            name: "Email (SMTP)", type: "smtp", enabled: smtpEnabled,
            config: {
              host: data.smtp_host ?? "", port: data.smtp_port ?? 25,
              user: data.smtp_user ?? "", pass: data.smtp_pass ?? "",
              from: data.smtp_from ?? "", alert_to: data.smtp_alert_to ?? "",
              secure: data.smtp_port === 465,
            } as JsonObj,
          },
          create: {
            id: "smtp-default", name: "Email (SMTP)", type: "smtp", enabled: smtpEnabled,
            config: {
              host: data.smtp_host ?? "", port: data.smtp_port ?? 25,
              user: data.smtp_user ?? "", pass: data.smtp_pass ?? "",
              from: data.smtp_from ?? "", alert_to: data.smtp_alert_to ?? "",
              secure: data.smtp_port === 465,
            } as JsonObj,
          },
        });
        break;
      }

      case "notifications":
        if (data.slack_webhook) await upsertChannel("slack-default", "Slack", "slack", { url: data.slack_webhook, custom_payload: data.slack_custom_payload ?? "" });
        if (data.teams_webhook) await upsertChannel("teams-default", "Teams", "teams", { url: data.teams_webhook, custom_payload: data.teams_custom_payload ?? "" });
        if (data.discord_webhook) await upsertChannel("discord-default", "Discord", "discord", { url: data.discord_webhook, custom_payload: data.discord_custom_payload ?? "" });
        if ("telegram_token" in data || "telegram_bot_token" in data) {
          const token = (data.telegram_token || data.telegram_bot_token) as string;
          const chatId = data.telegram_chat_id as string;
          if (token && chatId) {
            await upsertChannel("telegram-default", "Telegram", "telegram", { token, chat_id: chatId, custom_payload: data.telegram_custom_payload ?? "" });
          }
        }
        if (data.generic_webhook) await upsertChannel("webhook-default", "Webhook", "webhook", { url: data.generic_webhook, custom_payload: data.webhook_custom_payload ?? "" });
        break;

      case "azure_kv":
        await upsertAppConfig("azure_kv_tenant", String(data.tenant_id ?? ""));
        await upsertAppConfig("azure_kv_client", String(data.client_id ?? ""));
        await upsertAppConfig("azure_kv_secret", String(data.client_secret ?? ""));
        await upsertAppConfig("azure_kv_vault", String(data.vault_url ?? ""));
        break;

      case "oauth":
        await upsertAppConfig("oauth_google_enabled", String(data.google_enabled === true));
        await upsertAppConfig("oauth_google_client_id", String(data.google_client_id ?? ""));
        await upsertAppConfig("oauth_google_client_secret", String(data.google_client_secret ?? ""));
        await upsertAppConfig("oauth_microsoft_enabled", String(data.microsoft_enabled === true));
        await upsertAppConfig("oauth_microsoft_client_id", String(data.microsoft_client_id ?? ""));
        await upsertAppConfig("oauth_microsoft_client_secret", String(data.microsoft_client_secret ?? ""));
        await upsertAppConfig("oauth_microsoft_tenant_id", String(data.microsoft_tenant_id ?? "common"));
        break;

      default:
        return NextResponse.json({ error: `Unknown section: ${section}` }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function upsertAppConfig(key: string, value: string) {
  await db.appConfig.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function upsertChannel(id: string, name: string, type: string, config: unknown) {
  await db.alertChannel.upsert({
    where: { id },
    update: { name, type, config: config as object, enabled: true },
    create: { id, name, type, config: config as object, enabled: true },
  });
}
