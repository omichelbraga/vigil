import type { AlertPayload } from "./types";

const STATUS_COLORS: Record<string, string> = {
  critical: "#d32f2f",
  warning: "#f57c00",
  ok: "#388e3c",
  unknown: "#757575",
};

/**
 * Send an alert notification to a Slack incoming webhook.
 */
export async function sendSlack(
  webhookUrl: string,
  payload: AlertPayload
): Promise<void> {
  const color = STATUS_COLORS[payload.status] ?? STATUS_COLORS.unknown;
  const statusLabel = payload.isResolved ? "RESOLVED" : payload.status.toUpperCase();

  const body = {
    text: `[${statusLabel}] ${payload.agentName} - ${payload.checkName}`,
    attachments: [
      {
        color,
        fields: [
          { title: "Agent", value: payload.agentName, short: true },
          { title: "Check", value: payload.checkName, short: true },
          { title: "Status", value: statusLabel, short: true },
          { title: "Time", value: payload.timestamp, short: true },
        ],
        text: payload.message,
        footer: "Vigil Monitoring",
        ts: Math.floor(new Date(payload.timestamp).getTime() / 1000),
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(
      `Slack webhook failed with status ${response.status}: ${text}`
    );
  }
}
