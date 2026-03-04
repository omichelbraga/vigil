import { decrypt } from "@/lib/encryption";
import type { AlertPayload, TwilioConfig } from "./types";

/**
 * Send an alert notification via Twilio SMS.
 * Credentials (authToken) are decrypted from the database config at send time.
 */
export async function sendTwilio(
  config: TwilioConfig,
  to: string,
  payload: AlertPayload
): Promise<void> {
  const accountSid = safeDecrypt(config.accountSid);
  const authToken = safeDecrypt(config.authToken);
  const from = config.from;

  const statusLabel = payload.isResolved
    ? "RESOLVED"
    : payload.status.toUpperCase();

  const body = [
    `[Vigil ${statusLabel}]`,
    `Agent: ${payload.agentName}`,
    `Check: ${payload.checkName}`,
    `Status: ${statusLabel}`,
    `Time: ${payload.timestamp}`,
    `${payload.message}`,
  ].join("\n");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const params = new URLSearchParams();
  params.set("From", from);
  params.set("To", to);
  params.set("Body", body);

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString(
    "base64"
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(
      `Twilio API failed with status ${response.status}: ${text}`
    );
  }
}

/**
 * Attempt to decrypt a value. If it fails (e.g. value is plaintext),
 * return the original value.
 */
function safeDecrypt(value: string): string {
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}
