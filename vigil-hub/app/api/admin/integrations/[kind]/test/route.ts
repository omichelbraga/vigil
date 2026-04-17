import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import {
  channelIdForKind,
  isChannelKind,
  isIntegrationKind,
  loadChannelRuntimeConfig,
  recordDelivery,
  type IntegrationKind,
} from "@/lib/integrations";
import { assertExternalUrl, assertExternalHostname } from "@/lib/url-safety";

interface RouteContext {
  params: Promise<{ kind: string }>;
}

interface TestResult {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  latencyMs: number;
}

/**
 * POST /api/admin/integrations/[kind]/test
 * Sends a real test notification using the currently stored config. Every
 * attempt — success or failure — is recorded in NotificationDelivery so it
 * shows up in the channel's recent-deliveries log alongside real alerts.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { kind } = await ctx.params;
  if (!isIntegrationKind(kind)) {
    return NextResponse.json({ error: `Unknown integration: ${kind}` }, { status: 404 });
  }
  if (!isChannelKind(kind)) {
    return NextResponse.json(
      { error: `Integration '${kind}' has no test action` },
      { status: 400 },
    );
  }

  const runtime = await loadChannelRuntimeConfig(kind);
  if (!runtime) {
    return NextResponse.json(
      { error: "Integration not configured yet — save credentials first" },
      { status: 400 },
    );
  }

  const result = await performTest(kind, runtime.config);

  await recordDelivery({
    channelId: channelIdForKind(kind),
    status: result.ok ? "success" : "failed",
    title: "Manual test notification",
    httpStatus: result.httpStatus,
    lastError: result.error,
    latencyMs: result.latencyMs,
    attempts: 1,
  });

  await audit(req, auth.user.id, "integration.test", {
    entityType: "integration",
    entityId: kind,
    metadata: { ok: result.ok, httpStatus: result.httpStatus },
  });

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error ?? "Test failed" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    success: true,
    message: `Test sent to ${kind}`,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
  });
}

async function performTest(
  kind: IntegrationKind,
  cfg: Record<string, unknown>,
): Promise<TestResult> {
  const start = Date.now();
  try {
    switch (kind) {
      case "slack":
        return await postJson(
          stringField(cfg, "url"),
          { text: "Vigil — test notification. Your Slack integration is working." },
          start,
        );

      case "teams":
        return await postJson(
          stringField(cfg, "url"),
          {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            summary: "Vigil Test",
            title: "Vigil — test notification",
            text: "Your Microsoft Teams integration is working.",
          },
          start,
        );

      case "discord":
        return await postJson(
          stringField(cfg, "url"),
          {
            content: "Vigil — test notification.",
            embeds: [
              {
                title: "Test",
                description: "Discord integration OK.",
                color: 0x00c853,
              },
            ],
          },
          start,
        );

      case "webhook":
        return await postJson(
          stringField(cfg, "url"),
          {
            source: "vigil",
            type: "test",
            message: "Vigil — test notification.",
            timestamp: new Date().toISOString(),
          },
          start,
        );

      case "telegram": {
        const token = stringField(cfg, "token");
        const chatId = stringField(cfg, "chat_id");
        if (!token || !chatId) {
          return fail(start, null, "Telegram requires token and chat_id");
        }
        const res = await fetch(
          `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "Vigil — test notification. Telegram integration works.",
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return fail(start, res.status, `Telegram returned ${res.status}: ${body}`);
        }
        return ok(start, res.status);
      }

      case "pagerduty": {
        const routingKey = stringField(cfg, "routing_key");
        if (!routingKey) {
          return fail(start, null, "PagerDuty requires routing_key");
        }
        const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routing_key: routingKey,
            event_action: "trigger",
            dedup_key: `vigil-test-${Date.now()}`,
            payload: {
              summary: "Vigil — test notification",
              source: "vigil-monitoring",
              severity: "info",
              timestamp: new Date().toISOString(),
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return fail(start, res.status, `PagerDuty returned ${res.status}: ${body}`);
        }
        return ok(start, res.status);
      }

      case "twilio": {
        const sid = stringField(cfg, "sid");
        const token = stringField(cfg, "token");
        const from = stringField(cfg, "from");
        const to = stringField(cfg, "to");
        if (!sid || !token || !from || !to) {
          return fail(start, null, "Twilio requires sid, token, from, to");
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
              Body: "Vigil — test notification. Twilio integration works.",
            }).toString(),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return fail(start, res.status, `Twilio returned ${res.status}: ${body}`);
        }
        return ok(start, res.status);
      }

      case "smtp": {
        const host = stringField(cfg, "host");
        const portValue = cfg.port;
        const port =
          typeof portValue === "number"
            ? portValue
            : Number.parseInt(String(portValue ?? "25"), 10) || 25;
        if (!host) return fail(start, null, "SMTP requires host");
        await assertExternalHostname(host);
        const nodemailer = await import("nodemailer");
        const transporter = nodemailer.default.createTransport({
          host,
          port,
          secure: port === 465,
          auth: cfg.user
            ? {
                user: String(cfg.user),
                pass: String(cfg.pass ?? ""),
              }
            : undefined,
          tls: { rejectUnauthorized: false },
        });
        await transporter.verify();
        return ok(start, null);
      }

      default:
        return fail(start, null, `No test handler for ${kind}`);
    }
  } catch (err) {
    return fail(start, null, err instanceof Error ? err.message : String(err));
  }
}

function stringField(cfg: Record<string, unknown>, key: string): string {
  const v = cfg[key];
  return typeof v === "string" ? v : "";
}

async function postJson(
  url: string,
  body: unknown,
  start: number,
): Promise<TestResult> {
  if (!url) return fail(start, null, "Missing URL");
  await assertExternalUrl(url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return fail(start, res.status, `Returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return ok(start, res.status);
}

function ok(start: number, httpStatus: number | null): TestResult {
  return {
    ok: true,
    httpStatus,
    error: null,
    latencyMs: Date.now() - start,
  };
}

function fail(
  start: number,
  httpStatus: number | null,
  error: string,
): TestResult {
  return {
    ok: false,
    httpStatus,
    error,
    latencyMs: Date.now() - start,
  };
}
