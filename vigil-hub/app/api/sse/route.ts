import { getSession } from "@/lib/session";
import { NextRequest } from "next/server";


import { db } from "@/lib/db";
import { addSSEClient } from "@/lib/ws-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`),
      );

      // Subscribe to the in-memory broadcaster used by the WebSocket server
      // and the alert engine. This is what delivers `agent_status` (single),
      // `agent_action`, and `incident_*` events to the browser in real time.
      // The DB poller below continues to serve `check_result` events sourced
      // from the results table.
      const unsubscribeBroadcast = addSSEClient((event, json) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${json}\n\n`));
        } catch {
          // Controller closed; cleanup happens in abort handler.
        }
      });

      // Heartbeat every 15 seconds to keep the connection alive
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`),
          );
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      // Poll for new check results every 5 seconds
      let lastPollTime = new Date();
      const poller = setInterval(async () => {
        if (closed) return;
        try {
          const newResults = await db.checkResult.findMany({
            where: { timestamp: { gt: lastPollTime } },
            select: {
              id: true,
              checkId: true,
              agentId: true,
              status: true,
              message: true,
              responseTimeMs: true,
              timestamp: true,
              check: { select: { name: true, type: true } },
              agent: { select: { name: true } },
            },
            orderBy: { timestamp: "asc" },
            take: 100,
          });

          if (newResults.length > 0) {
            lastPollTime = newResults[newResults.length - 1].timestamp;
            for (const result of newResults) {
              controller.enqueue(
                encoder.encode(`event: check_result\ndata: ${JSON.stringify(result)}\n\n`),
              );
            }
          }

          // Poll for agent status changes
          const agents = await db.agent.findMany({
            where: { isActive: true, NOT: { tokenHash: "hub-internal" } },
            select: {
              id: true,
              name: true,
              lastSeen: true,
            },
          });

          const now = new Date();
          const agentStatuses = agents.map((a) => ({
            id: a.id,
            name: a.name,
            status:
              a.lastSeen && now.getTime() - a.lastSeen.getTime() < 120_000
                ? "online"
                : "offline",
            lastSeen: a.lastSeen,
          }));

          controller.enqueue(
            encoder.encode(`event: agent_status\ndata: ${JSON.stringify(agentStatuses)}\n\n`),
          );
        } catch {
          // Silently handle polling errors; connection may have closed
        }
      }, 5_000);

      // Clean up when the client disconnects
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        clearInterval(poller);
        try {
          unsubscribeBroadcast();
        } catch {
          // Already unsubscribed
        }
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
