import { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "./db";
import argon2 from "argon2";

interface ConnectedAgent {
  ws: WebSocket;
  agentId: string;
  agentName: string;
}

// Connected agents map
const agents = new Map<string, ConnectedAgent>();

// SSE clients for broadcasting
const sseClients = new Set<(event: string, data: string) => void>();

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

    // Only upgrade /ws/agent path
    if (url.pathname !== "/ws/agent" && url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
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

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, agentRecord);
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, agent: { id: string; name: string }) => {
      console.log(`Agent connected: ${agent.name} (${agent.id})`);

      agents.set(agent.id, { ws, agentId: agent.id, agentName: agent.name });

      // Update agent status
      db.agent
        .update({
          where: { id: agent.id },
          data: { lastSeen: new Date() },
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
          .update({
            where: { id: agent.id },
            data: { lastSeen: new Date() },
          })
          .catch(console.error);

        broadcast("agent_status", {
          agentId: agent.id,
          name: agent.name,
          status: "offline",
        });
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
): Promise<{ id: string; name: string } | null> {
  // Get all active agents and try to verify against each hash
  // This is necessary because argon2 hashes include salt
  const agentRecords = await db.agent.findMany({
    where: { isActive: true },
    select: { id: true, name: true, tokenHash: true },
  });

  for (const agent of agentRecords) {
    try {
      if (await argon2.verify(agent.tokenHash, token)) {
        return { id: agent.id, name: agent.name };
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

      // Find or create the check
      let check = await db.check.findFirst({
        where: { agentId: agent.id, name: checkName },
      });

      if (!check) {
        // Auto-create check from agent report
        const monitorType = checkName.split(":")[0] || "unknown";
        check = await db.check.create({
          data: {
            agentId: agent.id,
            name: checkName,
            type: monitorType,
            config: {},
          },
        });
      }

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

      break;
    }

    default:
      console.warn(`Unknown message type from ${agent.name}: ${type}`);
  }
}
