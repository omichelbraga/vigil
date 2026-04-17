/**
 * Unified Monitor types — the shape returned by /api/monitors and consumed
 * by the /monitors UI.
 *
 * "kind" distinguishes the three underlying record sources (Check / CertMonitor
 * / ExpiryMonitor). "type" is the fine-grained monitor type ("http", "cert",
 * "expiry", etc.) that the UI uses for icons and filtering.
 */

export type MonitorKind = "check" | "cert" | "expiry";

export type MonitorType =
  | "http"
  | "port"
  | "ping"
  | "service"
  | "cert"
  | "expiry"
  | "resource"
  | "process"
  | "logfile"
  | "event_log";

export type MonitorStatus =
  | "ok"
  | "warning"
  | "critical"
  | "unknown"
  | "silenced";

export interface MonitorSummary {
  id: string;
  kind: MonitorKind;
  name: string;
  type: MonitorType;
  target: string;
  agentName: string | null;
  agentId: string | null;
  intervalSecs: number | null;
  status: MonitorStatus;
  /** Last 24 hourly-bucketed average response-time values. Empty for certs/expiry. */
  latencySparkline: number[];
  slo: number | null;
  lastResultAt: string | null;
  /** True when lastResultAt is older than 3× intervalSecs — agent stopped reporting. */
  isStale: boolean;
  silencedUntil: string | null;
  runbookMarkdown: string | null;
}

export interface MonitorListResponse {
  items: MonitorSummary[];
  total: number;
  page: number;
  perPage: number;
}

export const CHECK_MONITOR_TYPES: readonly MonitorType[] = [
  "http",
  "port",
  "ping",
  "service",
  "cert",
  "resource",
  "process",
  "logfile",
  "event_log",
] as const;

export const ALL_MONITOR_TYPES: readonly MonitorType[] = [
  ...CHECK_MONITOR_TYPES,
  "expiry",
] as const;

/** Human-readable label for a monitor type. */
export function monitorTypeLabel(t: MonitorType): string {
  switch (t) {
    case "http":
      return "HTTP";
    case "port":
      return "TCP Port";
    case "ping":
      return "Ping";
    case "service":
      return "Service";
    case "cert":
      return "SSL Certificate";
    case "expiry":
      return "Expiry";
    case "resource":
      return "Resource";
    case "process":
      return "Process";
    case "logfile":
      return "Log File";
    case "event_log":
      return "Event Log";
    default:
      return t;
  }
}
