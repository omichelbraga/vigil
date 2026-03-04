import type { AlertPayload } from "./types";

const STATUS_COLORS: Record<string, number> = {
  critical: 0xd32f2f,
  warning: 0xf57c00,
  ok: 0x388e3c,
  unknown: 0x757575,
};

/**
 * Send an alert notification to a Discord webhook using embeds.
 */
export async function sendDiscord(
  webhookUrl: string,
  payload: AlertPayload
): Promise<void> {
  const color = STATUS_COLORS[payload.status] ?? STATUS_COLORS.unknown;
  const statusLabel = payload.isResolved ? "RESOLVED" : payload.status.toUpperCase();

  const body = {
    embeds: [
      {
        title: `[${statusLabel}] ${payload.agentName} - ${payload.checkName}`,
        description: payload.message,
        color,
        fields: [
          { name: "Agent", value: payload.agentName, inline: true },
          { name: "Check", value: payload.checkName, inline: true },
          { name: "Status", value: statusLabel, inline: true },
        ],
        timestamp: new Date(payload.timestamp).toISOString(),
        footer: {
          text: "Vigil Monitoring",
        },
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
      `Discord webhook failed with status ${response.status}: ${text}`
    );
  }
}
