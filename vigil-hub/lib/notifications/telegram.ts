import type { AlertPayload } from "./types";

const STATUS_EMOJI: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E0}",
  ok: "\u{1F7E2}",
  unknown: "\u{26AA}",
};

/**
 * Send an alert notification via Telegram Bot API.
 */
export async function sendTelegram(
  botToken: string,
  chatId: string,
  payload: AlertPayload
): Promise<void> {
  const icon = STATUS_EMOJI[payload.status] ?? STATUS_EMOJI.unknown;
  const statusLabel = payload.isResolved ? "RESOLVED" : payload.status.toUpperCase();

  const text = [
    `${icon} <b>[${statusLabel}]</b>`,
    ``,
    `<b>Agent:</b> ${escapeHtml(payload.agentName)}`,
    `<b>Check:</b> ${escapeHtml(payload.checkName)}`,
    `<b>Status:</b> ${statusLabel}`,
    `<b>Time:</b> ${escapeHtml(payload.timestamp)}`,
    ``,
    `${escapeHtml(payload.message)}`,
  ].join("\n");

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "unknown error");
    throw new Error(
      `Telegram API failed with status ${response.status}: ${body}`
    );
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(
      `Telegram API returned error: ${result.description ?? "unknown"}`
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
