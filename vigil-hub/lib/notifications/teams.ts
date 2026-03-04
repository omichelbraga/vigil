import type { AlertPayload } from "./types";

const STATUS_COLORS: Record<string, string> = {
  critical: "attention",
  warning: "warning",
  ok: "good",
  unknown: "default",
};

/**
 * Send an alert notification to a Microsoft Teams incoming webhook
 * using the Adaptive Card format.
 */
export async function sendTeams(
  webhookUrl: string,
  payload: AlertPayload
): Promise<void> {
  const style = STATUS_COLORS[payload.status] ?? STATUS_COLORS.unknown;
  const statusLabel = payload.isResolved ? "RESOLVED" : payload.status.toUpperCase();

  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "Container",
              style,
              items: [
                {
                  type: "TextBlock",
                  text: `[${statusLabel}] ${payload.agentName}`,
                  weight: "Bolder",
                  size: "Medium",
                  color: payload.status === "critical" ? "Attention" : "Default",
                },
              ],
            },
            {
              type: "FactSet",
              facts: [
                { title: "Agent", value: payload.agentName },
                { title: "Check", value: payload.checkName },
                { title: "Status", value: statusLabel },
                { title: "Time", value: payload.timestamp },
              ],
            },
            {
              type: "TextBlock",
              text: payload.message,
              wrap: true,
            },
          ],
        },
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(
      `Teams webhook failed with status ${response.status}: ${text}`
    );
  }
}
