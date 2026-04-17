import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { encrypt, decrypt } from "./encryption";

/**
 * Canonical list of integration kinds exposed through /admin/integrations.
 * These drive the card grid, the detail pages, and the API routes.
 *
 * Each kind corresponds to either:
 *   - an AlertChannel row (slack/teams/discord/telegram/pagerduty/twilio/smtp/webhook), or
 *   - an AppConfig-backed integration (azure_kv, oauth_google, oauth_microsoft).
 */
export const INTEGRATION_KINDS = [
  "slack",
  "teams",
  "discord",
  "telegram",
  "pagerduty",
  "twilio",
  "smtp",
  "webhook",
  "azure_kv",
  "oauth_google",
  "oauth_microsoft",
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export function isIntegrationKind(value: string): value is IntegrationKind {
  return (INTEGRATION_KINDS as readonly string[]).includes(value);
}

/** Channel-kinds that back an AlertChannel row. */
export const CHANNEL_KINDS: ReadonlyArray<IntegrationKind> = [
  "slack",
  "teams",
  "discord",
  "telegram",
  "pagerduty",
  "twilio",
  "smtp",
  "webhook",
] as const;

export function isChannelKind(kind: IntegrationKind): boolean {
  return CHANNEL_KINDS.includes(kind);
}

/** Stable AlertChannel row id for each channel kind. */
export function channelIdForKind(kind: IntegrationKind): string {
  switch (kind) {
    case "slack":
      return "slack-default";
    case "teams":
      return "teams-default";
    case "discord":
      return "discord-default";
    case "telegram":
      return "telegram-default";
    case "pagerduty":
      return "pagerduty-default";
    case "twilio":
      return "twilio-default";
    case "smtp":
      return "smtp-default";
    case "webhook":
      return "webhook-default";
    default:
      throw new Error(`Not a channel kind: ${kind}`);
  }
}

export function humanLabel(kind: IntegrationKind): string {
  switch (kind) {
    case "slack":
      return "Slack";
    case "teams":
      return "Microsoft Teams";
    case "discord":
      return "Discord";
    case "telegram":
      return "Telegram";
    case "pagerduty":
      return "PagerDuty";
    case "twilio":
      return "Twilio (SMS)";
    case "smtp":
      return "SMTP Email";
    case "webhook":
      return "Generic Webhook";
    case "azure_kv":
      return "Azure Key Vault";
    case "oauth_google":
      return "Google OAuth";
    case "oauth_microsoft":
      return "Microsoft OAuth";
  }
}

export const REDACTED = "••••••••";

/** Best-effort decrypt — returns "" if the stored value isn't encrypted. */
export function safeDecrypt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

/**
 * Record a single notification delivery attempt. Fire-and-forget: any DB
 * failure is logged but never thrown — the alerting path must not be blocked
 * by telemetry bookkeeping.
 *
 * When `channelId` refers to a row that isn't guaranteed to exist (synthetic
 * tests, agent-offline fan-outs, legacy channels), the FK constraint will
 * surface as an error and we skip the write.
 */
export async function recordDelivery(params: {
  channelId: string;
  status: "success" | "failed" | "retrying";
  title?: string | null;
  httpStatus?: number | null;
  lastError?: string | null;
  latencyMs?: number | null;
  attempts?: number;
  incidentId?: string | null;
}): Promise<void> {
  try {
    const exists = await db.alertChannel.findUnique({
      where: { id: params.channelId },
      select: { id: true },
    });
    if (!exists) return;
    await db.notificationDelivery.create({
      data: {
        channelId: params.channelId,
        status: params.status,
        title: params.title ?? null,
        httpStatus: params.httpStatus ?? null,
        lastError: params.lastError ? params.lastError.slice(0, 500) : null,
        latencyMs: params.latencyMs ?? null,
        attempts: params.attempts ?? 1,
        incidentId: params.incidentId ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[integrations] failed to record delivery", {
      channelId: params.channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Summary surfaced by GET /api/admin/integrations for each card. */
export interface IntegrationSummary {
  kind: IntegrationKind;
  label: string;
  configured: boolean;
  enabled: boolean;
  channelId: string | null;
  lastDelivery: {
    status: "success" | "failed" | "retrying";
    sentAt: string;
  } | null;
}

/** Full config envelope for an integration (secrets always redacted). */
export interface IntegrationDetail {
  kind: IntegrationKind;
  label: string;
  configured: boolean;
  enabled: boolean;
  channelId: string | null;
  /** Non-secret fields, ready for form prefill. Secret fields come back redacted. */
  config: Record<string, unknown>;
  /** Names of fields that are secret-typed (so the UI can show password inputs + redact sentinel). */
  secretFields: ReadonlyArray<string>;
}

/** Field sets the UI prefills, per kind. Keep in sync with write mapping below. */
export const SECRET_FIELDS: Record<IntegrationKind, ReadonlyArray<string>> = {
  slack: [],
  teams: [],
  discord: [],
  telegram: ["token"],
  pagerduty: ["routing_key"],
  twilio: ["token"],
  smtp: ["pass"],
  webhook: [],
  azure_kv: ["client_secret"],
  oauth_google: ["client_secret"],
  oauth_microsoft: ["client_secret"],
};

export async function loadIntegrationSummaries(): Promise<IntegrationSummary[]> {
  const [channels, appConfigs, lastDeliveries] = await Promise.all([
    db.alertChannel.findMany({
      select: { id: true, type: true, enabled: true, config: true },
    }),
    db.appConfig.findMany({
      where: {
        key: {
          in: [
            "azure_kv_vault",
            "azure_kv_tenant",
            "azure_kv_client",
            "azure_kv_secret",
            "azure_kv_enabled",
            "oauth_google_enabled",
            "oauth_google_client_id",
            "oauth_google_client_secret",
            "oauth_microsoft_enabled",
            "oauth_microsoft_client_id",
            "oauth_microsoft_client_secret",
            "oauth_microsoft_tenant_id",
          ],
        },
      },
    }),
    // One row per channel — pick the most recent delivery.
    db.notificationDelivery.findMany({
      orderBy: { sentAt: "desc" },
      take: 200,
      select: { channelId: true, status: true, sentAt: true },
    }),
  ]);

  const lastByChannel = new Map<
    string,
    { status: string; sentAt: Date }
  >();
  for (const d of lastDeliveries) {
    if (!lastByChannel.has(d.channelId)) {
      lastByChannel.set(d.channelId, { status: d.status, sentAt: d.sentAt });
    }
  }

  const appMap = new Map(appConfigs.map((c) => [c.key, c.value]));

  const summaries: IntegrationSummary[] = [];

  for (const kind of INTEGRATION_KINDS) {
    if (isChannelKind(kind)) {
      const id = channelIdForKind(kind);
      const row = channels.find((c) => c.id === id);
      const configured = Boolean(row && hasChannelCreds(kind, row.config));
      const last = lastByChannel.get(id);
      summaries.push({
        kind,
        label: humanLabel(kind),
        configured,
        enabled: row?.enabled ?? false,
        channelId: row?.id ?? null,
        lastDelivery: last
          ? {
              status: last.status as "success" | "failed" | "retrying",
              sentAt: last.sentAt.toISOString(),
            }
          : null,
      });
      continue;
    }

    if (kind === "azure_kv") {
      const configured =
        (appMap.get("azure_kv_vault") ?? "").length > 0 &&
        (appMap.get("azure_kv_tenant") ?? "").length > 0 &&
        (appMap.get("azure_kv_client") ?? "").length > 0;
      const enabled = appMap.get("azure_kv_enabled") === "true";
      summaries.push({
        kind,
        label: humanLabel(kind),
        configured,
        enabled: configured && enabled,
        channelId: null,
        lastDelivery: null,
      });
      continue;
    }

    if (kind === "oauth_google") {
      const configured =
        (appMap.get("oauth_google_client_id") ?? "").length > 0;
      summaries.push({
        kind,
        label: humanLabel(kind),
        configured,
        enabled: appMap.get("oauth_google_enabled") === "true",
        channelId: null,
        lastDelivery: null,
      });
      continue;
    }

    if (kind === "oauth_microsoft") {
      const configured =
        (appMap.get("oauth_microsoft_client_id") ?? "").length > 0;
      summaries.push({
        kind,
        label: humanLabel(kind),
        configured,
        enabled: appMap.get("oauth_microsoft_enabled") === "true",
        channelId: null,
        lastDelivery: null,
      });
      continue;
    }
  }

  return summaries;
}

function hasChannelCreds(kind: IntegrationKind, config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  switch (kind) {
    case "slack":
    case "teams":
    case "discord":
    case "webhook":
      return typeof c.url === "string" && c.url.length > 0;
    case "telegram":
      return (
        typeof c.token === "string" &&
        c.token.length > 0 &&
        typeof c.chat_id === "string" &&
        c.chat_id.length > 0
      );
    case "pagerduty":
      return typeof c.routing_key === "string" && c.routing_key.length > 0;
    case "twilio":
      return (
        typeof c.sid === "string" &&
        c.sid.length > 0 &&
        typeof c.token === "string" &&
        c.token.length > 0
      );
    case "smtp":
      return typeof c.host === "string" && c.host.length > 0;
    default:
      return false;
  }
}

export async function loadIntegrationDetail(
  kind: IntegrationKind,
): Promise<IntegrationDetail> {
  if (isChannelKind(kind)) {
    const id = channelIdForKind(kind);
    const row = await db.alertChannel.findUnique({ where: { id } });
    const raw = (row?.config as Record<string, unknown> | undefined) ?? {};
    const redacted: Record<string, unknown> = { ...raw };
    for (const secret of SECRET_FIELDS[kind]) {
      if (redacted[secret]) redacted[secret] = REDACTED;
    }
    return {
      kind,
      label: humanLabel(kind),
      configured: hasChannelCreds(kind, raw),
      enabled: row?.enabled ?? false,
      channelId: row?.id ?? null,
      config: redacted,
      secretFields: SECRET_FIELDS[kind],
    };
  }

  const configs = await db.appConfig.findMany();
  const map = new Map(configs.map((c) => [c.key, c.value]));

  if (kind === "azure_kv") {
    const vault = map.get("azure_kv_vault") ?? "";
    const tenant = map.get("azure_kv_tenant") ?? "";
    const clientId = map.get("azure_kv_client") ?? "";
    const hasSecret = (map.get("azure_kv_secret") ?? "").length > 0;
    return {
      kind,
      label: humanLabel(kind),
      configured: Boolean(vault && tenant && clientId),
      enabled: map.get("azure_kv_enabled") === "true",
      channelId: null,
      config: {
        vault_url: vault,
        tenant_id: tenant,
        client_id: clientId,
        client_secret: hasSecret ? REDACTED : "",
      },
      secretFields: SECRET_FIELDS[kind],
    };
  }

  if (kind === "oauth_google") {
    const clientId = map.get("oauth_google_client_id") ?? "";
    const hasSecret = (map.get("oauth_google_client_secret") ?? "").length > 0;
    return {
      kind,
      label: humanLabel(kind),
      configured: Boolean(clientId),
      enabled: map.get("oauth_google_enabled") === "true",
      channelId: null,
      config: {
        client_id: clientId,
        client_secret: hasSecret ? REDACTED : "",
      },
      secretFields: SECRET_FIELDS[kind],
    };
  }

  if (kind === "oauth_microsoft") {
    const clientId = map.get("oauth_microsoft_client_id") ?? "";
    const tenantId = map.get("oauth_microsoft_tenant_id") ?? "common";
    const hasSecret =
      (map.get("oauth_microsoft_client_secret") ?? "").length > 0;
    return {
      kind,
      label: humanLabel(kind),
      configured: Boolean(clientId),
      enabled: map.get("oauth_microsoft_enabled") === "true",
      channelId: null,
      config: {
        client_id: clientId,
        tenant_id: tenantId,
        client_secret: hasSecret ? REDACTED : "",
      },
      secretFields: SECRET_FIELDS[kind],
    };
  }

  // Exhaustive fallback — TS should catch this at compile-time.
  throw new Error(`Unsupported kind: ${kind}`);
}

/** Upsert an AlertChannel row for a channel kind. Used by PATCH and tests. */
async function upsertChannelRow(
  kind: IntegrationKind,
  payload: {
    enabled: boolean;
    config: Record<string, unknown>;
  },
): Promise<string> {
  const id = channelIdForKind(kind);
  const name = humanLabel(kind);
  await db.alertChannel.upsert({
    where: { id },
    update: {
      name,
      type: kind,
      enabled: payload.enabled,
      config: payload.config as Prisma.InputJsonValue,
    },
    create: {
      id,
      name,
      type: kind,
      enabled: payload.enabled,
      config: payload.config as Prisma.InputJsonValue,
    },
  });
  return id;
}

async function upsertAppConfig(key: string, value: string): Promise<void> {
  await db.appConfig.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/**
 * Merge an inbound PATCH with the existing channel config, handling the
 * REDACTED sentinel so secrets aren't wiped on re-save.
 */
async function mergeChannelConfig(
  kind: IntegrationKind,
  incoming: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = channelIdForKind(kind);
  const existing = await db.alertChannel.findUnique({ where: { id } });
  const existingConfig =
    (existing?.config as Record<string, unknown> | undefined) ?? {};

  const next: Record<string, unknown> = { ...existingConfig };

  for (const [key, value] of Object.entries(incoming)) {
    // Secret handling — redaction sentinel means "keep existing".
    if (SECRET_FIELDS[kind].includes(key)) {
      if (typeof value !== "string" || value.length === 0 || value === REDACTED) {
        // leave existing
        continue;
      }
      next[key] = encrypt(value);
      continue;
    }
    next[key] = value;
  }

  return next;
}

export interface IntegrationPatchInput {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/**
 * Apply a PATCH to an integration. Returns a refreshed detail payload so the
 * caller can optimistic-update the UI with the authoritative state.
 */
export async function applyIntegrationPatch(
  kind: IntegrationKind,
  input: IntegrationPatchInput,
): Promise<IntegrationDetail> {
  if (isChannelKind(kind)) {
    const mergedConfig = input.config
      ? await mergeChannelConfig(kind, input.config)
      : undefined;

    const id = channelIdForKind(kind);
    const existing = await db.alertChannel.findUnique({ where: { id } });
    const existingConfig =
      (existing?.config as Record<string, unknown> | undefined) ?? {};

    await upsertChannelRow(kind, {
      enabled: input.enabled ?? existing?.enabled ?? false,
      config: mergedConfig ?? existingConfig,
    });

    return loadIntegrationDetail(kind);
  }

  if (kind === "azure_kv") {
    const cfg = input.config ?? {};
    if (typeof cfg.vault_url === "string")
      await upsertAppConfig("azure_kv_vault", cfg.vault_url);
    if (typeof cfg.tenant_id === "string")
      await upsertAppConfig("azure_kv_tenant", cfg.tenant_id);
    if (typeof cfg.client_id === "string")
      await upsertAppConfig("azure_kv_client", cfg.client_id);
    if (
      typeof cfg.client_secret === "string" &&
      cfg.client_secret.length > 0 &&
      cfg.client_secret !== REDACTED
    ) {
      await upsertAppConfig("azure_kv_secret", encrypt(cfg.client_secret));
    }
    if (input.enabled !== undefined) {
      await upsertAppConfig("azure_kv_enabled", String(input.enabled === true));
    }
    return loadIntegrationDetail(kind);
  }

  if (kind === "oauth_google") {
    const cfg = input.config ?? {};
    if (typeof cfg.client_id === "string")
      await upsertAppConfig("oauth_google_client_id", cfg.client_id);
    if (
      typeof cfg.client_secret === "string" &&
      cfg.client_secret.length > 0 &&
      cfg.client_secret !== REDACTED
    ) {
      await upsertAppConfig(
        "oauth_google_client_secret",
        encrypt(cfg.client_secret),
      );
    }
    if (input.enabled !== undefined) {
      await upsertAppConfig(
        "oauth_google_enabled",
        String(input.enabled === true),
      );
    }
    return loadIntegrationDetail(kind);
  }

  if (kind === "oauth_microsoft") {
    const cfg = input.config ?? {};
    if (typeof cfg.client_id === "string")
      await upsertAppConfig("oauth_microsoft_client_id", cfg.client_id);
    if (typeof cfg.tenant_id === "string")
      await upsertAppConfig(
        "oauth_microsoft_tenant_id",
        cfg.tenant_id,
      );
    if (
      typeof cfg.client_secret === "string" &&
      cfg.client_secret.length > 0 &&
      cfg.client_secret !== REDACTED
    ) {
      await upsertAppConfig(
        "oauth_microsoft_client_secret",
        encrypt(cfg.client_secret),
      );
    }
    if (input.enabled !== undefined) {
      await upsertAppConfig(
        "oauth_microsoft_enabled",
        String(input.enabled === true),
      );
    }
    return loadIntegrationDetail(kind);
  }

  throw new Error(`Unsupported kind: ${kind}`);
}

/**
 * Resolve the full, decrypted channel config for runtime use (tests,
 * dispatcher). Never return this directly to the client — use loadIntegrationDetail.
 */
export async function loadChannelRuntimeConfig(
  kind: IntegrationKind,
): Promise<{ enabled: boolean; config: Record<string, unknown> } | null> {
  if (!isChannelKind(kind)) return null;
  const id = channelIdForKind(kind);
  const row = await db.alertChannel.findUnique({ where: { id } });
  if (!row) return null;
  const raw = (row.config as Record<string, unknown>) ?? {};
  const decrypted: Record<string, unknown> = { ...raw };
  for (const secret of SECRET_FIELDS[kind]) {
    if (typeof decrypted[secret] === "string") {
      decrypted[secret] = safeDecrypt(decrypted[secret]);
    }
  }
  return { enabled: row.enabled, config: decrypted };
}
