import nodemailer from "nodemailer";
import { decrypt } from "@/lib/encryption";
import type { AlertPayload, SmtpConfig } from "./types";

const STATUS_COLORS: Record<string, string> = {
  critical: "#d32f2f",
  warning: "#f57c00",
  ok: "#388e3c",
  unknown: "#757575",
};

/**
 * Send an alert notification via SMTP email using nodemailer.
 * Credentials are decrypted from the database config at send time.
 */
export async function sendEmail(
  config: SmtpConfig,
  to: string,
  payload: AlertPayload
): Promise<void> {
  const decryptedUser = safeDecrypt(config.user);
  const decryptedPass = safeDecrypt(config.pass);

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: decryptedUser,
      pass: decryptedPass,
    },
  });

  const statusLabel = payload.isResolved
    ? "RESOLVED"
    : payload.status.toUpperCase();
  const color = STATUS_COLORS[payload.status] ?? STATUS_COLORS.unknown;
  const subject = `[Vigil ${statusLabel}] ${payload.agentName} - ${payload.checkName}`;

  const html = buildHtmlTemplate(payload, statusLabel, color);

  await transporter.sendMail({
    from: config.from,
    to,
    subject,
    html,
    text: buildPlainText(payload, statusLabel),
  });
}

/**
 * Attempt to decrypt a value. If it fails (e.g. value is plaintext),
 * return the original value. This allows both encrypted and plaintext
 * configs to work.
 */
function safeDecrypt(value: string): string {
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

function buildPlainText(payload: AlertPayload, statusLabel: string): string {
  return [
    `[${statusLabel}] ${payload.agentName} - ${payload.checkName}`,
    ``,
    `Agent: ${payload.agentName}`,
    `Check: ${payload.checkName}`,
    `Status: ${statusLabel}`,
    `Time: ${payload.timestamp}`,
    ``,
    payload.message,
    ``,
    `-- Vigil Monitoring`,
  ].join("\n");
}

function buildHtmlTemplate(
  payload: AlertPayload,
  statusLabel: string,
  color: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vigil Alert</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:${color};padding:20px 32px;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">
                ${statusLabel}: ${escapeHtml(payload.agentName)}
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;">
                    <strong style="color:#555;">Agent</strong>
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">
                    ${escapeHtml(payload.agentName)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;">
                    <strong style="color:#555;">Check</strong>
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">
                    ${escapeHtml(payload.checkName)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;">
                    <strong style="color:#555;">Status</strong>
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">
                    <span style="display:inline-block;padding:2px 10px;border-radius:12px;background-color:${color};color:#fff;font-size:13px;font-weight:600;">
                      ${statusLabel}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;">
                    <strong style="color:#555;">Time</strong>
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">
                    ${escapeHtml(payload.timestamp)}
                  </td>
                </tr>
              </table>
              <div style="margin-top:24px;padding:16px;background-color:#f9f9f9;border-radius:6px;border-left:4px solid ${color};">
                <p style="margin:0;color:#333;font-size:14px;line-height:1.6;">
                  ${escapeHtml(payload.message)}
                </p>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #eee;">
              <p style="margin:0;color:#999;font-size:12px;text-align:center;">
                Sent by Vigil Monitoring
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
