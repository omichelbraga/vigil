import { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "./db";
import argon2 from "argon2";
import { processAlert, sendAgentOfflineAlert, sendAgentOnlineAlert } from "./alert-engine";

interface ConnectedAgent {
  ws: WebSocket;
  agentId: string;
  agentName: string;
}

// Use global to survive Next.js production module re-instantiation across route bundles
declare global {
  // eslint-disable-next-line no-var
  var _vigilAgents: Map<string, ConnectedAgent> | undefined;
  // eslint-disable-next-line no-var
  var _vigilSseClients: Set<(event: string, data: string) => void> | undefined;
}

const agents: Map<string, ConnectedAgent> =
  global._vigilAgents ?? (global._vigilAgents = new Map());

const sseClients: Set<(event: string, data: string) => void> =
  global._vigilSseClients ?? (global._vigilSseClients = new Set());

/** Returns the set of agent IDs currently connected via WebSocket */
export function getConnectedAgentIds(): Set<string> {
  return new Set((global._vigilAgents ?? agents).keys());
}

export function addSSEClient(send: (event: string, data: string) => void) {
  sseClients.add(send);
  return () => sseClients.delete(send);
}

function broadcast(event: string, data: unknown) {
  const json = JSON.stringify(data);
  for (const send of sseClients) {
    try {
      send(event, json);
    } catch {
      // Client disconnected, will be cleaned up
    }
  }
}

export function setupWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    // Only handle /ws/agent — let everything else (including Next.js HMR) pass through
    if (url.pathname !== "/ws/agent" && url.pathname !== "/ws") {
      // Don't destroy — let Next.js handle its own WebSocket upgrades (HMR, etc.)
      return;
    }

    // Extract Bearer token from Authorization header
    const authHeader = request.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : url.searchParams.get("token") || "";

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Verify token against stored agent hashes
    const agentRecord = await verifyAgentToken(token);
    if (!agentRecord) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Block pending agents from connecting
    if (agentRecord.status === "pending") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Capture remote IP at upgrade time (before ws handshake)
    const remoteIp =
      (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      (request.socket as { remoteAddress?: string })?.remoteAddress ||
      null;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, { ...agentRecord, remoteIp });
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, agent: { id: string; name: string; remoteIp?: string | null }) => {
      console.log(`Agent connected: ${agent.name} (${agent.id}) from ${agent.remoteIp ?? "unknown"}`);

      agents.set(agent.id, { ws, agentId: agent.id, agentName: agent.name });

      // Update agent status + IP, fire recovery alert if agent was offline
      db.agent
        .findUnique({ where: { id: agent.id }, select: { lastSeen: true } })
        .then((prev) => {
          const wasOffline = !prev?.lastSeen || (Date.now() - prev.lastSeen.getTime()) > 90_000;
          return db.agent.update({
            where: { id: agent.id },
            data: {
              lastSeen: new Date(),
              ...(agent.remoteIp ? { ipAddress: agent.remoteIp } : {}),
            },
          }).then(() => {
            if (wasOffline) sendAgentOnlineAlert(agent.name).catch(console.error);
          });
        })
        .catch(console.error);

      // Push configured checks to agent on connect
      db.check
        .findMany({
          where: { agentId: agent.id, enabled: true },
          select: { id: true, name: true, type: true, config: true, intervalSecs: true },
        })
        .then((checks) => {
          // Only push checks that have a valid name and meaningful config
          const valid = checks.filter((c) => c.name && c.name.trim().length > 0);
          if (valid.length > 0) {
            ws.send(JSON.stringify({
              type: "configure_checks",
              checks: valid.map((c) => ({
                id: c.id,
                name: c.name,
                type: c.type,
                config: c.config,
                interval_seconds: c.intervalSecs,
              })),
            }));
          }
        })
        .catch(console.error);

      broadcast("agent_status", {
        agentId: agent.id,
        name: agent.name,
        status: "online",
      });

      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          await handleMessage(agent, msg);
        } catch (err) {
          console.error("Failed to handle WS message:", err);
        }
      });

      ws.on("close", () => {
        console.log(`Agent disconnected: ${agent.name}`);
        agents.delete(agent.id);

        db.agent
          .update({ where: { id: agent.id }, data: { lastSeen: new Date() } })
          .catch(console.error);

        broadcast("agent_status", {
          agentId: agent.id,
          name: agent.name,
          status: "offline",
        });

        // Mark all checks for this agent as unknown (stale)
        db.check.findMany({ where: { agentId: agent.id, enabled: true }, select: { id: true } })
          .then((checks) => {
            const now = new Date();
            return Promise.all(checks.map((c) =>
              db.checkResult.create({
                data: {
                  checkId: c.id,
                  agentId: agent.id,
                  status: "unknown",
                  message: `Agent ${agent.name} is offline`,
                  timestamp: now,
                },
              })
            ));
          })
          .catch(console.error);

        // Fire agent-offline alert
        sendAgentOfflineAlert(agent.name).catch(console.error);
      });

      ws.on("error", (err) => {
        console.error(`WebSocket error for agent ${agent.name}:`, err);
      });
    }
  );

  return wss;
}

async function verifyAgentToken(
  token: string
): Promise<{ id: string; name: string; status: string } | null> {
  // Get all active agents and try to verify against each hash
  // This is necessary because argon2 hashes include salt
  const agentRecords = await db.agent.findMany({
    where: { isActive: true },
    select: { id: true, name: true, tokenHash: true, status: true },
  });

  for (const agent of agentRecords) {
    try {
      if (await argon2.verify(agent.tokenHash, token)) {
        return { id: agent.id, name: agent.name, status: agent.status };
      }
    } catch {
      // Invalid hash format, skip
    }
  }

  return null;
}

async function handleMessage(
  agent: { id: string; name: string },
  msg: Record<string, unknown>
) {
  const type = msg.type as string;

  switch (type) {
    case "register": {
      await db.agent.update({
        where: { id: agent.id },
        data: {
          version: (msg.version as string) || null,
          os: (msg.os as string) || null,
          hostname: (msg.hostname as string) || null,
          lastSeen: new Date(),
        },
      });
      break;
    }

    case "heartbeat": {
      await db.agent.update({
        where: { id: agent.id },
        data: { lastSeen: new Date() },
      });
      break;
    }

    case "check_result": {
      const checkName = msg.check_name as string;
      const status = msg.status as string;
      const latencyMs = msg.latency_ms as number | undefined;
      const message = msg.message as string | undefined;
      const checkedAt = msg.checked_at as string | undefined;
      const metadata = msg.metadata as Record<string, unknown> | undefined;

      // Normalize check name: strip type prefix (e.g. "service:Spooler" → "Spooler")
      const monitorType = checkName.includes(":") ? checkName.split(":")[0] : "unknown";
      const displayName = checkName.includes(":") ? checkName.split(":").slice(1).join(":") : checkName;

      // Find check: try exact name, then stripped display name, then by config.name
      let check = await db.check.findFirst({
        where: { agentId: agent.id, name: checkName },
      }) ?? await db.check.findFirst({
        where: { agentId: agent.id, name: displayName },
      });

      if (!check) {
        // Fallback: search all agent checks and match by config.name
        // (handles case where display name differs from service name, e.g. "Xbox Live Auth Manager" vs "XblAuthManager")
        const agentChecks = await db.check.findMany({
          where: { agentId: agent.id },
          select: { id: true, name: true, type: true, config: true, intervalSecs: true },
        });
        const matched = agentChecks.find((c) => {
          const cfg = c.config as Record<string, unknown> | null;
          return cfg?.name === displayName || cfg?.name === checkName;
        });
        if (matched) check = matched as typeof check;
      }

      if (!check && displayName.trim().length > 0) {
        // Auto-create only if no match and name is non-empty (config-file monitors not in Hub)
        check = await db.check.create({
          data: {
            agentId: agent.id,
            name: displayName,
            type: monitorType,
            config: {},
          },
        });
      }

      // Skip result if we still have no check (e.g. empty-name reports)
      if (!check) break;

      // Store result
      const result = await db.checkResult.create({
        data: {
          checkId: check.id,
          agentId: agent.id,
          status: status,
          message: message || null,
          responseTimeMs: latencyMs ? Math.round(latencyMs) : null,
          metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
          timestamp: checkedAt ? new Date(checkedAt) : new Date(),
        },
      });

      // Broadcast to SSE clients
      broadcast("check_result", {
        agentId: agent.id,
        agentName: agent.name,
        checkId: check.id,
        checkName,
        status,
        latencyMs,
        message,
        timestamp: result.timestamp,
      });

      // Update agent lastSeen
      await db.agent.update({
        where: { id: agent.id },
        data: { lastSeen: new Date() },
      });

      // Fire/resolve alerts based on status change
      processAlert({
        checkId: check.id,
        checkName,
        agentId: agent.id,
        agentName: agent.name,
        status,
        message,
      }).catch((err) => console.error("Alert engine error:", err));

      break;
    }

    default:
      console.warn(`Unknown message type from ${agent.name}: ${type}`);
  }
}
