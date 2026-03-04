import { decrypt } from "@/lib/encryption";
import type { AlertPayload, GenericWebhookConfig } from "./types";

/**
 * Send an alert notification to a generic webhook endpoint.
 * Supports a simple {{variable}} template engine for the request body
 * and decryption of header values that may contain secrets.
 */
export async function sendGeneric(
  config: GenericWebhookConfig,
  payload: AlertPayload
): Promise<void> {
  const url = config.url;
  const method = (config.method || "POST").toUpperCase();

  // Build template variables
  const variables: Record<string, string> = {
    status: payload.isResolved ? "resolved" : payload.status,
    agent: payload.agentName,
    check: payload.checkName,
    message: payload.message,
    timestamp: payload.timestamp,
    isResolved: String(payload.isResolved ?? false),
  };

  // Render body from template
  const body = renderTemplate(config.bodyTemplate, variables);

  // Decrypt header values that may contain secrets (e.g. API keys)
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    headers[key] = safeDecrypt(value);
  }

  // Default to JSON content type if not specified
  if (
    !Object.keys(headers).some(
      (k) => k.toLowerCase() === "content-type"
    )
  ) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(
      `Generic webhook failed with status ${response.status}: ${text}`
    );
  }
}

/**
 * Simple template engine that replaces {{variable}} placeholders
 * with their corresponding values.
 */
function renderTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in variables ? variables[key] : match;
  });
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
