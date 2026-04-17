/**
 * Event classification for the notifications tray.
 *
 * The tray subscribes to SSE events that come from `lib/ws-server.ts` and
 * converts raw payloads into a narrow, display-ready shape. We deliberately
 * ignore fields that might contain tokens, credentials, or secrets — the
 * tray only ever needs a title, subtitle, severity, and a navigation target.
 */

export type TraySeverity = "crit" | "warn" | "info";

export interface TrayEvent {
  id: string;
  receivedAt: string; // ISO
  severity: TraySeverity;
  title: string;
  subtitle: string;
  navHref: string | null;
  // Raw event type for debugging/grouping; never user-visible verbatim.
  source: string;
}

interface AgentStatusPayload {
  agentId: string;
  name: string;
  status: "online" | "offline";
}

interface CheckResultPayload {
  checkId: string;
  checkName: string;
  agentId: string;
  agentName: string;
  status: "ok" | "warning" | "critical" | "unknown";
  message?: string | null;
}

interface AgentActionPayload {
  agentId: string;
  agentName: string;
  action: string;
  checkId?: string | null;
  accepted?: boolean;
  status?: string;
  reason?: string;
}

interface IncidentPayload {
  checkId?: string;
  checkName?: string;
  agentName?: string;
  status?: string;
  message?: string;
  firedAt?: string;
  resolvedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function randomId(): string {
  // Browser-first: crypto.randomUUID() when present, otherwise timestamp-rand.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Translate a raw SSE event into a tray-friendly entry.
 *
 * Returns `null` when the event should be skipped (e.g. `check_result` with
 * status "ok" — these would dominate the tray and are already visible on the
 * monitors page).
 */
export function classifyEvent(eventName: string, data: unknown): TrayEvent | null {
  // Agent status is the simplest: online / offline.
  if (eventName === "agent_status") {
    // The existing SSE poller broadcasts an ARRAY of agent statuses every 5s.
    // The ws-server broadcasts a SINGLE record on connect/disconnect. We only
    // want the single-record form — arrays are too noisy for the tray.
    if (Array.isArray(data)) return null;
    if (!isRecord(data)) return null;
    const p = data as unknown as AgentStatusPayload;
    const name = str(p.name, "agent");
    const agentId = str(p.agentId);
    if (p.status === "online") {
      return {
        id: randomId(),
        receivedAt: new Date().toISOString(),
        severity: "info",
        title: `Agent ${name} is online`,
        subtitle: "Reconnected and reporting",
        navHref: agentId ? `/agents/${agentId}` : null,
        source: eventName,
      };
    }
    if (p.status === "offline") {
      return {
        id: randomId(),
        receivedAt: new Date().toISOString(),
        severity: "crit",
        title: `Agent ${name} offline`,
        subtitle: "Host unreachable",
        navHref: agentId ? `/agents/${agentId}` : null,
        source: eventName,
      };
    }
    return null;
  }

  if (eventName === "check_result") {
    if (!isRecord(data)) return null;
    // The DB-polling SSE route nests check + agent; the ws-server broadcast is
    // flat. Normalise both shapes.
    const flat = data as unknown as Partial<CheckResultPayload> & {
      check?: { name?: string };
      agent?: { name?: string };
    };
    const status = str(flat.status).toLowerCase();
    // Skip ok/unknown — too noisy for the tray.
    if (status !== "critical" && status !== "warning") return null;

    const checkName = str(flat.checkName) || str(flat.check?.name, "check");
    const agentName = str(flat.agentName) || str(flat.agent?.name, "agent");
    const checkId = str(flat.checkId);
    const message = str(flat.message, status.toUpperCase());

    return {
      id: randomId(),
      receivedAt: new Date().toISOString(),
      severity: status === "critical" ? "crit" : "warn",
      title: `${checkName} on ${agentName} ${status}`,
      subtitle: message.slice(0, 160),
      navHref: checkId ? `/monitors?highlight=${encodeURIComponent(checkId)}` : "/monitors",
      source: eventName,
    };
  }

  if (eventName === "agent_action") {
    if (!isRecord(data)) return null;
    const p = data as unknown as AgentActionPayload;
    const verb = p.accepted === false ? "denied" : "ack";
    return {
      id: randomId(),
      receivedAt: new Date().toISOString(),
      severity: "info",
      title: `Action ${str(p.action, "unknown")} on ${str(p.agentName, "agent")}`,
      subtitle: p.accepted === false
        ? str(p.reason, "denied by agent")
        : str(p.status, verb),
      navHref: "/monitors",
      source: eventName,
    };
  }

  if (eventName === "incident_fired") {
    if (!isRecord(data)) return null;
    const p = data as unknown as IncidentPayload;
    const status = str(p.status, "critical").toLowerCase();
    const severity: TraySeverity = status === "warning" ? "warn" : "crit";
    return {
      id: randomId(),
      receivedAt: new Date().toISOString(),
      severity,
      title: `${str(p.checkName, "Check")} on ${str(p.agentName, "agent")} ${status}`,
      subtitle: str(p.message, "Incident fired").slice(0, 160),
      navHref: "/alerts",
      source: eventName,
    };
  }

  if (eventName === "incident_resolved") {
    if (!isRecord(data)) return null;
    const p = data as unknown as IncidentPayload;
    return {
      id: randomId(),
      receivedAt: new Date().toISOString(),
      severity: "info",
      title: `${str(p.checkName, "Check")} on ${str(p.agentName, "agent")} recovered`,
      subtitle: "Incident resolved",
      navHref: "/alerts",
      source: eventName,
    };
  }

  return null;
}

export const TRAY_EVENT_NAMES: readonly string[] = [
  "agent_status",
  "check_result",
  "agent_action",
  "incident_fired",
  "incident_resolved",
];
