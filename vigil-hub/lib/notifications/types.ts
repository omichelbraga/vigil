export interface AlertPayload {
  agentName: string;
  checkName: string;
  status: "ok" | "warning" | "critical" | "unknown";
  message: string;
  timestamp: string;
  isResolved?: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

export interface GenericWebhookConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate: string;
}

export interface CheckResult {
  checkId: string;
  agentId: string;
  status: "ok" | "warning" | "critical" | "unknown";
  message: string;
  responseTimeMs: number;
}
