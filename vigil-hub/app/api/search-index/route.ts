import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getConnectedAgentIds } from "@/lib/ws-server";
import type { MonitorKind, MonitorType } from "@/lib/monitors";
import { CHECK_MONITOR_TYPES } from "@/lib/monitors";

export interface SearchIndexAgent {
  id: string;
  name: string;
  status: "online" | "offline" | "pending";
}

export interface SearchIndexMonitor {
  id: string;
  kind: MonitorKind;
  name: string;
  type: MonitorType;
  agentName: string | null;
}

export interface SearchIndexIncident {
  id: string;
  title: string;
  severity: "warning" | "critical";
  agentName: string | null;
}

export interface SearchIndexResponse {
  agents: SearchIndexAgent[];
  monitors: SearchIndexMonitor[];
  incidents: SearchIndexIncident[];
  generatedAt: string;
}

const AGENT_LIMIT = 50;
const MONITOR_LIMIT = 100;
const INCIDENT_LIMIT = 20;

type CheckConfig = Record<string, unknown>;

function mapCheckType(raw: string): MonitorType {
  return (CHECK_MONITOR_TYPES as readonly string[]).includes(raw)
    ? (raw as MonitorType)
    : "http";
}

export async function GET(
  req: NextRequest,
): Promise<NextResponse<SearchIndexResponse | { error: string }>> {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [rawAgents, rawChecks, rawCerts, rawExpiries, rawIncidents] =
    await Promise.all([
      db.agent.findMany({
        where: { isActive: true, NOT: { tokenHash: "hub-internal" } },
        select: { id: true, name: true, status: true },
        orderBy: { name: "asc" },
        take: AGENT_LIMIT,
      }),
      db.check.findMany({
        where: { agent: { isActive: true } },
        select: {
          id: true,
          name: true,
          type: true,
          config: true,
          agent: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: MONITOR_LIMIT,
      }),
      db.certMonitor.findMany({
        select: { id: true, host: true },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      db.expiryMonitor.findMany({
        select: { id: true, name: true },
        orderBy: { expiresAt: "asc" },
        take: 25,
      }),
      db.incident.findMany({
        where: { status: "firing" },
        select: {
          id: true,
          title: true,
          severity: true,
          agent: { select: { name: true } },
        },
        orderBy: { firedAt: "desc" },
        take: INCIDENT_LIMIT,
      }),
    ]);

  const connectedIds = getConnectedAgentIds();
  const agents: SearchIndexAgent[] = rawAgents.map((a) => ({
    id: a.id,
    name: a.name,
    status:
      a.status === "pending"
        ? "pending"
        : connectedIds.has(a.id)
          ? "online"
          : "offline",
  }));

  const monitors: SearchIndexMonitor[] = [];
  for (const c of rawChecks) {
    // Use config.url/host for http/port as a hint, but primary identifier is name.
    void (c.config as CheckConfig | null);
    monitors.push({
      id: c.id,
      kind: "check",
      name: c.name,
      type: mapCheckType(c.type),
      agentName: c.agent?.name ?? null,
    });
  }
  for (const cert of rawCerts) {
    monitors.push({
      id: cert.id,
      kind: "cert",
      name: cert.host,
      type: "cert",
      agentName: null,
    });
  }
  for (const exp of rawExpiries) {
    monitors.push({
      id: exp.id,
      kind: "expiry",
      name: exp.name,
      type: "expiry",
      agentName: null,
    });
  }

  // Cap aggregated monitors at MONITOR_LIMIT.
  const cappedMonitors = monitors.slice(0, MONITOR_LIMIT);

  const incidents: SearchIndexIncident[] = rawIncidents.map((i) => ({
    id: i.id,
    title: i.title,
    severity: (i.severity === "critical" ? "critical" : "warning") as
      | "warning"
      | "critical",
    agentName: i.agent?.name ?? null,
  }));

  const body: SearchIndexResponse = {
    agents,
    monitors: cappedMonitors,
    incidents,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "private, max-age=15",
    },
  });
}
