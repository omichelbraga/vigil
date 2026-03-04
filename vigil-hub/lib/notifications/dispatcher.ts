import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { sendSlack } from "./slack";
import { sendTeams } from "./teams";
import { sendDiscord } from "./discord";
import { sendTelegram } from "./telegram";
import { sendEmail } from "./smtp";
import { sendTwilio } from "./twilio";
import { sendGeneric } from "./generic";
import type {
  AlertPayload,
  CheckResult,
  SmtpConfig,
  TwilioConfig,
  GenericWebhookConfig,
} from "./types";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface AlertRuleWithChannel {
  id: string;
  channelId: string;
  condition: unknown;
  cooldownMinutes: number;
  channel: {
    id: string;
    type: string;
    config: unknown;
  };
}

/**
 * AlertDispatcher is the central engine for evaluating alert rules
 * against check results and dispatching notifications through the
 * appropriate channels.
 */
export class AlertDispatcher {
  /**
   * Dispatch alert notifications for a check result against a set of rules.
   *
   * For each rule:
   * 1. Check cooldown -- skip if an alert was recently sent for this check.
   * 2. Detect recovery -- if the check was previously critical/warning and
   *    is now ok, send a resolve notification.
   * 3. Route to the appropriate channel sender.
   * 4. Log the result to AlertHistory.
   * 5. Retry up to 3 times on transient failure.
   */
  static async dispatch(
    checkResult: CheckResult,
    rules: AlertRuleWithChannel[]
  ): Promise<void> {
    for (const rule of rules) {
      try {
        await AlertDispatcher.processRule(checkResult, rule);
      } catch (error) {
        console.error(
          `[AlertDispatcher] Unhandled error processing rule ${rule.id}:`,
          error
        );
      }
    }
  }

  private static async processRule(
    checkResult: CheckResult,
    rule: AlertRuleWithChannel
  ): Promise<void> {
    // 1. Check cooldown
    const isInCooldown = await AlertDispatcher.isInCooldown(
      checkResult.checkId,
      rule.id,
      rule.cooldownMinutes
    );

    if (isInCooldown && checkResult.status !== "ok") {
      // Still in cooldown for non-recovery alerts -- skip
      return;
    }

    // 2. Determine if this is a recovery notification
    const isResolved = await AlertDispatcher.isRecovery(
      checkResult.checkId,
      rule.id,
      checkResult.status
    );

    // Only send alerts for critical/warning statuses or recovery
    if (checkResult.status === "ok" && !isResolved) {
      return;
    }

    if (checkResult.status === "unknown" && !isResolved) {
      return;
    }

    // 3. Build the payload
    const agentName = await AlertDispatcher.resolveAgentName(
      checkResult.agentId
    );
    const checkName = await AlertDispatcher.resolveCheckName(
      checkResult.checkId
    );

    const payload: AlertPayload = {
      agentName,
      checkName,
      status: checkResult.status,
      message: checkResult.message,
      timestamp: new Date().toISOString(),
      isResolved,
    };

    // 4. Send with retries
    let lastError: Error | null = null;
    let delivered = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await AlertDispatcher.sendToChannel(rule.channel, payload);
        delivered = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[AlertDispatcher] Attempt ${attempt}/${MAX_RETRIES} failed for rule ${rule.id}:`,
          lastError.message
        );

        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    // 5. Log to AlertHistory
    await AlertDispatcher.logToHistory(
      rule.id,
      checkResult.checkId,
      delivered ? "delivered" : "failed",
      delivered
        ? payload.isResolved
          ? `Resolved: ${payload.message}`
          : payload.message
        : `Failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? "unknown error"}`,
      isResolved
    );

    if (!delivered && lastError) {
      throw lastError;
    }
  }

  /**
   * Check if a recent alert was sent for the same check + rule
   * within the cooldown period.
   */
  private static async isInCooldown(
    checkId: string,
    ruleId: string,
    cooldownMinutes: number
  ): Promise<boolean> {
    if (cooldownMinutes <= 0) return false;

    const cutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000);

    const recentAlert = await db.alertHistory.findFirst({
      where: {
        ruleId,
        status: "delivered",
        firedAt: { gte: cutoff },
      },
      orderBy: { firedAt: "desc" },
    });

    return recentAlert !== null;
  }

  /**
   * Determine if this is a recovery event: the previous alert for this
   * check + rule was critical or warning, and the current status is ok.
   */
  private static async isRecovery(
    checkId: string,
    ruleId: string,
    currentStatus: string
  ): Promise<boolean> {
    if (currentStatus !== "ok") return false;

    const lastAlert = await db.alertHistory.findFirst({
      where: {
        ruleId,
        status: "delivered",
        resolvedAt: null,
      },
      orderBy: { firedAt: "desc" },
    });

    if (lastAlert) {
      // Mark previous alert as resolved
      await db.alertHistory.update({
        where: { id: lastAlert.id },
        data: { resolvedAt: new Date() },
      });
      return true;
    }

    return false;
  }

  /**
   * Route the alert payload to the appropriate channel sender.
   */
  private static async sendToChannel(
    channel: { type: string; config: unknown },
    payload: AlertPayload
  ): Promise<void> {
    const config = channel.config as Record<string, unknown>;

    switch (channel.type) {
      case "slack": {
        const webhookUrl = safeDecrypt(config.webhookUrl as string);
        await sendSlack(webhookUrl, payload);
        break;
      }

      case "teams": {
        const webhookUrl = safeDecrypt(config.webhookUrl as string);
        await sendTeams(webhookUrl, payload);
        break;
      }

      case "discord": {
        const webhookUrl = safeDecrypt(config.webhookUrl as string);
        await sendDiscord(webhookUrl, payload);
        break;
      }

      case "telegram": {
        const botToken = safeDecrypt(config.botToken as string);
        const chatId = config.chatId as string;
        await sendTelegram(botToken, chatId, payload);
        break;
      }

      case "email": {
        const smtpConfig: SmtpConfig = {
          host: config.host as string,
          port: config.port as number,
          secure: (config.secure as boolean) ?? true,
          user: config.user as string,
          pass: config.pass as string,
          from: config.from as string,
        };
        const to = config.to as string;
        await sendEmail(smtpConfig, to, payload);
        break;
      }

      case "pagerduty": {
        // PagerDuty uses a generic webhook integration
        const routingKey = safeDecrypt(config.routingKey as string);
        await sendPagerDuty(routingKey, payload);
        break;
      }

      case "twilio": {
        const twilioConfig: TwilioConfig = {
          accountSid: config.accountSid as string,
          authToken: config.authToken as string,
          from: config.from as string,
        };
        const to = config.to as string;
        await sendTwilio(twilioConfig, to, payload);
        break;
      }

      case "webhook": {
        const webhookConfig: GenericWebhookConfig = {
          url: config.url as string,
          method: (config.method as string) ?? "POST",
          headers: (config.headers as Record<string, string>) ?? {},
          bodyTemplate:
            (config.bodyTemplate as string) ??
            JSON.stringify({
              status: "{{status}}",
              agent: "{{agent}}",
              check: "{{check}}",
              message: "{{message}}",
              timestamp: "{{timestamp}}",
            }),
        };
        await sendGeneric(webhookConfig, payload);
        break;
      }

      default:
        throw new Error(`Unsupported channel type: ${channel.type}`);
    }
  }

  /**
   * Log alert dispatch result to the AlertHistory table.
   */
  private static async logToHistory(
    ruleId: string,
    checkId: string,
    status: string,
    message: string,
    isResolved: boolean
  ): Promise<void> {
    try {
      await db.alertHistory.create({
        data: {
          ruleId,
          status,
          message,
          firedAt: new Date(),
          resolvedAt: isResolved ? new Date() : null,
        },
      });
    } catch (error) {
      console.error(
        `[AlertDispatcher] Failed to log alert history for rule ${ruleId}:`,
        error
      );
    }
  }

  /**
   * Resolve an agent ID to its display name.
   */
  private static async resolveAgentName(agentId: string): Promise<string> {
    try {
      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: { name: true },
      });
      return agent?.name ?? agentId;
    } catch {
      return agentId;
    }
  }

  /**
   * Resolve a check ID to its display name.
   */
  private static async resolveCheckName(checkId: string): Promise<string> {
    try {
      const check = await db.check.findUnique({
        where: { id: checkId },
        select: { name: true },
      });
      return check?.name ?? checkId;
    } catch {
      return checkId;
    }
  }
}

/**
 * Send a PagerDuty Events API v2 trigger or resolve event.
 */
async function sendPagerDuty(
  routingKey: string,
  payload: AlertPayload
): Promise<void> {
  const eventAction = payload.isResolved ? "resolve" : "trigger";
  const severity =
    payload.status === "critical"
      ? "critical"
      : payload.status === "warning"
        ? "warning"
        : "info";

  const body = {
    routing_key: routingKey,
    event_action: eventAction,
    dedup_key: `vigil-${payload.agentName}-${payload.checkName}`,
    payload: {
      summary: `[${payload.status.toUpperCase()}] ${payload.agentName} - ${payload.checkName}: ${payload.message}`,
      source: "vigil-monitoring",
      severity,
      timestamp: payload.timestamp,
      custom_details: {
        agent: payload.agentName,
        check: payload.checkName,
        message: payload.message,
      },
    },
  };

  const response = await fetch(
    "https://events.pagerduty.com/v2/enqueue",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(
      `PagerDuty API failed with status ${response.status}: ${text}`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to decrypt a value. If it fails, return the original value.
 */
function safeDecrypt(value: string): string {
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}
