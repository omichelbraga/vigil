import { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "./db";
import argon2 from "argon2";
import { processAlert, sendAgentOfflineAlert, sendAgentOnlineAlert } from "./alert-engine";
import { handleAgentReconnectForRollouts } from "./rollout-runner";
import { canonicalBodyForSigning, verifyEd25519 } from "./signature-verify";
import type { Prisma } from "@prisma/client";

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
  // eslint-disable-next-line no-var
  var _vigilRecentlyDisconnected: Set<string> | undefined;
}

const agents: Map<string, ConnectedAgent> =
  global._vigilAgents ?? (global._vigilAgents = new Map());

const sseClients: Set<(event: string, data: string) => void> =
  global._vigilSseClients ?? (global._vigilSseClients = new Set());

// Agent IDs that disconnected since this Hub process started. Used to fire the
// recovery alert on any reconnect, even fast ones that beat the lastSeen-based
// threshold. Cleared after a successful online-alert dispatch.
const recentlyDisconnected: Set<string> =
  global._vigilRecentlyDisconnected ?? (global._vigilRecentlyDisconnected = new Set());

// Threshold below which we don't consider "lastSeen" staleness alone sufficient
// to fire an online alert. Two heartbeat intervals (30s × 2) gives a comfortable
// margin for jittery networks.
const OFFLINE_LAST_SEEN_THRESHOLD_MS = 60_000;

/** Returns the set of agent IDs currently connected via WebSocket */
export function getConnectedAgentIds(): Set<string> {
  return new Set((global._vigilAgents ?? agents).keys());
}

/**
 * Send an arbitrary JSON message to a connected agent. Returns `true` if the
 * agent was connected and the ws.send call did not throw, `false` otherwise
 * (agent offline, socket closing, serialization error).
 *
 * This is the low-level primitive; callers should prefer the typed helpers
 * below (`runCheckNow`, `silenceCheckOnAgent`, `reloadAgentConfig`).
 */
export function sendAgentMessage(
  agentId: string,
  msg: Record<string, unknown>,
): boolean {
  const pool = global._vigilAgents ?? agents;
  const entry = pool.get(agentId);
  if (!entry) return false;
  try {
    entry.ws.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    console.error(`Failed to send ${String(msg.type)} to agent ${agentId}:`, err);
    return false;
  }
}

/** Ask a connected agent to execute a specific check once, now. */
export function runCheckNow(agentId: string, checkId: string): boolean {
  return sendAgentMessage(agentId, {
    type: "run_check_now",
    check_id: checkId,
  });
}

/**
 * Push a silence update to a connected agent. `until = null` clears the silence
 * (unmute). When `null`, the agent will resume running the check on schedule.
 */
export function silenceCheckOnAgent(
  agentId: string,
  checkId: string,
  until: Date | null,
): boolean {
  return sendAgentMessage(agentId, {
    type: "silence_check",
    check_id: checkId,
    until: until ? until.toISOString() : null,
  });
}

/** Ask a connected agent to reload its TOML config from disk. */
export function reloadAgentConfig(agentId: string): boolean {
  return sendAgentMessage(agentId, { type: "reload_config" });
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

/**
 * Public wrapper around the internal `broadcast()` helper for modules outside
 * the ws-server that need to push SSE events to connected browsers
 * (e.g. the alert engine emitting `incident_fired` / `incident_resolved`).
 *
 * Signature intentionally matches `broadcast` so callers that already have a
 * named event + JSON-serialisable payload can swap in without ceremony.
 */
export function broadcastSSE(event: string, data: unknown): void {
  broadcast(event, data);
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

      // Fire recovery alert when:
      //  (a) the agent was tracked as disconnected during this Hub process, or
      //  (b) the stored lastSeen is older than the offline threshold (catches
      //      reconnects after a Hub restart).
      db.agent
        .findUnique({ where: { id: agent.id }, select: { lastSeen: true } })
        .then((prev) => {
          const staleLastSeen =
            !prev?.lastSeen ||
            Date.now() - prev.lastSeen.getTime() > OFFLINE_LAST_SEEN_THRESHOLD_MS;
          const wasTrackedOffline = recentlyDisconnected.has(agent.id);
          const wasOffline = wasTrackedOffline || staleLastSeen;
          return db.agent
            .update({
              where: { id: agent.id },
              data: {
                lastSeen: new Date(),
                ...(agent.remoteIp ? { ipAddress: agent.remoteIp } : {}),
              },
            })
            .then(() => {
              if (wasOffline) {
                recentlyDisconnected.delete(agent.id);
                sendAgentOnlineAlert(agent.name).catch(console.error);
              }
            });
        })
        .catch(console.error);

      // Push configured checks on connect AND every 5 minutes while connected.
      // Self-heals when an agent loses its monitor list in-memory (observed on
      // legacy binaries mid-session). No-op if the agent doesn't need the update.
      const pushChecks = () => {
        db.check
          .findMany({
            where: { agentId: agent.id, enabled: true },
            select: { id: true, name: true, type: true, config: true, intervalSecs: true, silencedUntil: true },
          })
          .then((checks) => {
            const now = Date.now();
            const valid = checks
              .filter((c) => c.name && c.name.trim().length > 0)
              // Respect silencedUntil — don't push silenced checks to the agent.
              .filter((c) => !c.silencedUntil || c.silencedUntil.getTime() < now);
            if (valid.length > 0 && ws.readyState === ws.OPEN) {
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
      };
      pushChecks();
      const rePushInterval = setInterval(pushChecks, 5 * 60_000);
      ws.once("close", () => clearInterval(rePushInterval));

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

        // Mark offline so the next connect fires the recovery alert,
        // even if the reconnect happens within the lastSeen threshold.
        // NOTE: do NOT update lastSeen here — it should reflect the last real
        // contact, not the moment of disconnect.
        recentlyDisconnected.add(agent.id);

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

/** UUID v4 (or similar) sanity check for the agentId prefix. */
function looksLikeUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function verifyAgentToken(
  token: string
): Promise<{ id: string; name: string; status: string } | null> {
  // Fast path: new-style tokens are "<agentId>:<secret>" — O(1) lookup + one
  // argon2 verify. Falls back to the legacy scan for pre-fix tokens.
  const colon = token.indexOf(":");
  if (colon > 0) {
    const agentId = token.slice(0, colon);
    const secret = token.slice(colon + 1);
    if (looksLikeUUID(agentId) && secret.length > 0) {
      const agent = await db.agent.findFirst({
        where: { id: agentId, isActive: true },
        select: { id: true, name: true, tokenHash: true, status: true },
      });
      if (agent) {
        try {
          if (await argon2.verify(agent.tokenHash, secret)) {
            return { id: agent.id, name: agent.name, status: agent.status };
          }
        } catch {
          /* fall through to legacy scan */
        }
      }
      return null;
    }
  }

  // Legacy slow path: accept pre-fix tokens that are just the bare UUID secret.
  // Still O(N) in legacy-agent count, but new agents skip this entirely.
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
      /* skip */
    }
  }
  return null;
}

/**
 * Grace window during which agents that don't yet send a `public_key` (legacy
 * binaries) are allowed to bypass signature verification. After this window
 * elapses — measured from the agent's `createdAt` — unsigned messages are
 * dropped and audited. Tunable via env so ops can extend the transition
 * period without a code change.
 */
const RESULT_SIGN_GRACE_DAYS = Math.max(
  0,
  Number(process.env.VIGIL_RESULT_SIGN_GRACE_DAYS ?? "30") || 30,
);

/**
 * Fire-and-forget audit-log write from the WS layer. Mirrors `lib/audit.ts`
 * but omits the NextRequest-sourced IP/UA because we're outside the request
 * path. Errors are swallowed so a broken audit log can never take down the
 * WS handler.
 */
async function wsAudit(
  action: string,
  opts: {
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    const resource = opts.entityType ?? action.split(".").slice(-1)[0] ?? action;
    const meta: Record<string, unknown> = {};
    if (opts.entityId) meta.entityId = opts.entityId;
    if (opts.metadata) Object.assign(meta, opts.metadata);
    await db.auditLog.create({
      data: {
        userId: null,
        action,
        resource,
        ipAddress: null,
        metadata: meta as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error("[ws-audit] failed to persist log", {
      action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Verify the `signature` on an inbound WS message against the agent's pinned
 * ed25519 public key.
 *
 * Returns:
 *  * `{ ok: true }` when the sig is valid (or when the agent is still in the
 *    grace window and the message is unsigned — in which case `unsigned` is
 *    true so `check_result` callers can tag `metadata.signature_missing`).
 *  * `{ ok: false, reason }` when the message must be dropped. `reason` is
 *    a short machine code ("invalid_signature", "unsigned_after_grace").
 */
interface VerifyContext {
  pubkey: string | null;
  createdAt: Date;
}
function verifyInboundSignature(
  msg: Record<string, unknown>,
  ctx: VerifyContext,
): { ok: true; unsigned: boolean } | { ok: false; reason: string } {
  const rawSig = msg.signature;
  const hasSig = typeof rawSig === "string" && rawSig.length > 0;

  if (ctx.pubkey) {
    if (!hasSig) return { ok: false, reason: "missing_signature" };
    const canonical = canonicalBodyForSigning(msg);
    const ok = verifyEd25519(ctx.pubkey, rawSig as string, canonical);
    return ok ? { ok: true, unsigned: false } : { ok: false, reason: "invalid_signature" };
  }

  // No pinned pubkey yet. Accept unsigned messages during the grace window.
  const graceMs = RESULT_SIGN_GRACE_DAYS * 24 * 60 * 60_000;
  const withinGrace = Date.now() - ctx.createdAt.getTime() < graceMs;
  if (hasSig) {
    // Agent is sending sigs but we haven't pinned — shouldn't happen because
    // pinning is done on the `register` path before other messages arrive.
    // Tolerate it (accept + mark as unsigned so metadata is annotated).
    return { ok: true, unsigned: true };
  }
  if (withinGrace) return { ok: true, unsigned: true };
  return { ok: false, reason: "unsigned_after_grace" };
}

/**
 * Per-agent cache of (pubkey, createdAt) so we don't hit the DB on every
 * message. Invalidated by `register` pinning and by the admin reset endpoint
 * via `invalidateSigningContext`.
 */
const signingContextCache: Map<string, VerifyContext> = new Map();

async function getSigningContext(agentId: string): Promise<VerifyContext | null> {
  const cached = signingContextCache.get(agentId);
  if (cached) return cached;
  const row = await db.agent.findUnique({
    where: { id: agentId },
    select: { resultSigningPubkey: true, createdAt: true },
  });
  if (!row) return null;
  const ctx: VerifyContext = {
    pubkey: row.resultSigningPubkey,
    createdAt: row.createdAt,
  };
  signingContextCache.set(agentId, ctx);
  return ctx;
}

/** Force the next `getSigningContext` to re-read from the DB. */
export function invalidateSigningContext(agentId: string): void {
  signingContextCache.delete(agentId);
}

async function handleMessage(
  agent: { id: string; name: string },
  msg: Record<string, unknown>
) {
  const type = msg.type as string;

  // -----------------------------------------------------------------------
  // Signature gate (P6.4). Applied to *every* message type except the
  // register path, which pins a pubkey before we check. If verification
  // fails, drop the message silently + audit. We don't close the socket on
  // a single bad signature — one corrupted payload shouldn't knock the
  // agent offline.
  // -----------------------------------------------------------------------
  let unsignedInGrace = false;
  if (type !== "register") {
    const ctx = await getSigningContext(agent.id);
    if (!ctx) return; // agent record vanished — nothing to do
    const verdict = verifyInboundSignature(msg, ctx);
    if (!verdict.ok) {
      console.warn(
        `[ws-verify] dropping ${type} from ${agent.name}: ${verdict.reason}`,
      );
      await wsAudit(
        verdict.reason === "invalid_signature"
          ? "agent.invalid_signature"
          : "agent.unsigned_result",
        {
          entityType: "agent",
          entityId: agent.id,
          metadata: {
            agentName: agent.name,
            messageType: type,
            reason: verdict.reason,
          },
        },
      );
      return;
    }
    unsignedInGrace = verdict.unsigned;
  }

  switch (type) {
    case "register": {
      const reportedVersion = (msg.version as string) || null;

      // --------------------------------------------------------------------
      // Signing key pinning (P6.4). The agent ships its raw ed25519 public
      // key (64 hex chars) on first register. We pin it to the agent record
      // on first sight; any subsequent attempt to register with a different
      // key is rejected + audited (possible compromise or cross-reuse of
      // agent tokens between hosts).
      // --------------------------------------------------------------------
      const incomingPubkey =
        typeof msg.public_key === "string" ? msg.public_key.trim().toLowerCase() : "";
      const validPubkey = /^[0-9a-f]{64}$/.test(incomingPubkey);

      if (validPubkey) {
        const current = await db.agent.findUnique({
          where: { id: agent.id },
          select: { resultSigningPubkey: true },
        });
        if (!current) break;
        if (current.resultSigningPubkey === null) {
          await db.agent.update({
            where: { id: agent.id },
            data: {
              resultSigningPubkey: incomingPubkey,
              resultSigningPubkeyPinnedAt: new Date(),
            },
          });
          invalidateSigningContext(agent.id);
          await wsAudit("agent.pubkey_pinned", {
            entityType: "agent",
            entityId: agent.id,
            metadata: { agentName: agent.name, pubkeyPrefix: incomingPubkey.slice(0, 16) },
          });
          console.log(
            `[ws-verify] pinned ed25519 pubkey for ${agent.name} (${incomingPubkey.slice(0, 16)}...)`,
          );
        } else if (current.resultSigningPubkey !== incomingPubkey) {
          console.warn(
            `[ws-verify] pubkey mismatch for ${agent.name} — closing socket. pinned=${current.resultSigningPubkey.slice(0, 16)}... incoming=${incomingPubkey.slice(0, 16)}...`,
          );
          await wsAudit("agent.pubkey_mismatch", {
            entityType: "agent",
            entityId: agent.id,
            metadata: {
              agentName: agent.name,
              pinnedPrefix: current.resultSigningPubkey.slice(0, 16),
              incomingPrefix: incomingPubkey.slice(0, 16),
            },
          });
          const conn = agents.get(agent.id);
          try {
            conn?.ws.close(1008, "pubkey mismatch");
          } catch {
            /* ignore */
          }
          agents.delete(agent.id);
          return;
        }

        // Now that we've (possibly) pinned, verify the register message
        // itself — an attacker who flipped `public_key` during transit
        // mustn't be able to replace a pinned key on every register.
        const ctx = await getSigningContext(agent.id);
        if (ctx?.pubkey) {
          const canonical = canonicalBodyForSigning(msg);
          const sigHex = typeof msg.signature === "string" ? msg.signature : "";
          if (!verifyEd25519(ctx.pubkey, sigHex, canonical)) {
            console.warn(
              `[ws-verify] register from ${agent.name} had invalid signature — dropping`,
            );
            await wsAudit("agent.invalid_signature", {
              entityType: "agent",
              entityId: agent.id,
              metadata: { agentName: agent.name, messageType: "register" },
            });
            return;
          }
        }
      }

      await db.agent.update({
        where: { id: agent.id },
        data: {
          version: reportedVersion,
          os: (msg.os as string) || null,
          hostname: (msg.hostname as string) || null,
          lastSeen: new Date(),
        },
      });
      // P6.5 — if an in-flight rollout attempt exists for this agent and the
      // reported version matches the target, mark it success. Fire-and-forget.
      handleAgentReconnectForRollouts(agent.id, reportedVersion).catch((err) =>
        console.error("[ws-server] rollout reconnect handler failed:", err),
      );
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
      // Input validation — agents are a trust boundary. A rogue/compromised agent
      // must not be able to forge arbitrary statuses, backdate results, or
      // explode Postgres with unbounded payloads.
      const VALID_STATUSES = new Set(["ok", "warning", "critical", "unknown"]);
      const MAX_CHECK_NAME = 200;
      const MAX_MESSAGE = 2_000;
      const MAX_METADATA_BYTES = 16_384;

      const rawName = msg.check_name;
      if (typeof rawName !== "string" || rawName.length === 0 || rawName.length > MAX_CHECK_NAME) {
        console.warn(`Dropping check_result from ${agent.name}: invalid check_name`);
        break;
      }
      const checkName = rawName;

      const rawStatus = msg.status;
      if (typeof rawStatus !== "string" || !VALID_STATUSES.has(rawStatus)) {
        console.warn(`Dropping check_result from ${agent.name}: invalid status ${String(rawStatus)}`);
        break;
      }
      const status = rawStatus;

      const latencyMs =
        typeof msg.latency_ms === "number" && Number.isFinite(msg.latency_ms) && msg.latency_ms >= 0
          ? msg.latency_ms
          : undefined;

      const rawMsg = msg.message;
      const message =
        typeof rawMsg === "string" && rawMsg.length > 0
          ? rawMsg.slice(0, MAX_MESSAGE)
          : undefined;

      // Reject timestamps more than 10 minutes in the future (clock skew) or
      // older than 1 hour (stale replay). Undefined/invalid → stamp server-side.
      const rawCheckedAt = msg.checked_at;
      let checkedAt: string | undefined = undefined;
      if (typeof rawCheckedAt === "string" && rawCheckedAt.length > 0) {
        const t = Date.parse(rawCheckedAt);
        if (!Number.isNaN(t)) {
          const nowMs = Date.now();
          if (t > nowMs + 10 * 60_000 || t < nowMs - 60 * 60_000) {
            checkedAt = undefined; // out of window — use server time
          } else {
            checkedAt = rawCheckedAt;
          }
        }
      }

      const rawMeta = msg.metadata;
      let metadata: Record<string, unknown> | undefined;
      if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
        try {
          const serialized = JSON.stringify(rawMeta);
          if (serialized.length <= MAX_METADATA_BYTES) {
            metadata = rawMeta as Record<string, unknown>;
          }
        } catch {
          /* drop metadata on stringify failure */
        }
      }
      // Tamper-evidence (P6.4): flag legacy unsigned results so operators can
      // see which rows in `check_results` pre-date the pubkey pin. Displayed
      // in the UI as a "!" badge and counted in /admin/system.
      if (unsignedInGrace) {
        metadata = { ...(metadata ?? {}), signature_missing: true };
      }

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
        if (matched) check = matched as unknown as typeof check;
      }

      if (!check) {
        // Unknown check — don't auto-create. Auto-creating races when a
        // backlog drains (N concurrent inserts for the same name all succeed
        // and produce N duplicate rows), and masks the real bug of an agent
        // reporting for a check nobody configured. Admins must create the
        // monitor explicitly through the Monitors UI. Detect zombie sockets
        // here and close them so the log stays clean.
        const agentExists = await db.agent.count({ where: { id: agent.id, isActive: true } });
        if (agentExists === 0) {
          console.warn(
            `Zombie agent ws for ${agent.name} (${agent.id}) — agent record gone, closing socket`,
          );
          const conn = agents.get(agent.id);
          try { conn?.ws.close(1008, "agent record removed"); } catch {}
          agents.delete(agent.id);
          break;
        }
        console.warn(
          `Dropping check_result from ${agent.name}: no monitor configured for "${checkName}" (create it in /monitors)`,
        );
        break;
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

    case "inventory_report": {
      // Idempotent upsert keyed by agentId. Inventory is informational; we
      // validate shapes lightly (types only) and silently drop unknown fields
      // rather than crash on a forward-compat agent.
      const inv = msg.inventory as Record<string, unknown> | undefined;
      if (!inv || typeof inv !== "object") {
        console.warn(`Dropping inventory_report from ${agent.name}: missing inventory`);
        break;
      }
      try {
        const arch = typeof inv.arch === "string" ? inv.arch : null;
        const kernel = typeof inv.kernel === "string" ? inv.kernel : null;
        const cpuModel = typeof inv.cpu_model === "string" ? inv.cpu_model : null;
        const cpuCount =
          typeof inv.cpu_count === "number" && Number.isFinite(inv.cpu_count)
            ? Math.round(inv.cpu_count)
            : null;
        const totalRamBytes =
          typeof inv.total_ram_bytes === "number" && Number.isFinite(inv.total_ram_bytes)
            ? BigInt(Math.round(inv.total_ram_bytes))
            : null;
        const totalDiskBytes =
          typeof inv.total_disk_bytes === "number" && Number.isFinite(inv.total_disk_bytes)
            ? BigInt(Math.round(inv.total_disk_bytes))
            : null;
        const disks = Array.isArray(inv.disks) ? (inv.disks as unknown[]) : [];
        const nics = Array.isArray(inv.nics) ? (inv.nics as unknown[]) : [];
        const bootTimeRaw = inv.boot_time;
        const bootTime =
          typeof bootTimeRaw === "number" && Number.isFinite(bootTimeRaw) && bootTimeRaw > 0
            ? new Date(bootTimeRaw * 1000)
            : null;
        const container = typeof inv.container === "string" ? inv.container : null;

        await db.agentInventory.upsert({
          where: { agentId: agent.id },
          create: {
            agentId: agent.id,
            arch,
            kernel,
            cpuModel,
            cpuCount,
            totalRamBytes,
            totalDiskBytes,
            disks: disks as unknown as Parameters<typeof db.agentInventory.upsert>[0]["create"]["disks"],
            nics: nics as unknown as Parameters<typeof db.agentInventory.upsert>[0]["create"]["nics"],
            bootTime,
            container,
          },
          update: {
            arch,
            kernel,
            cpuModel,
            cpuCount,
            totalRamBytes,
            totalDiskBytes,
            disks: disks as unknown as Parameters<typeof db.agentInventory.upsert>[0]["update"]["disks"],
            nics: nics as unknown as Parameters<typeof db.agentInventory.upsert>[0]["update"]["nics"],
            bootTime,
            container,
          },
        });
      } catch (err) {
        console.warn(`Failed to upsert inventory for ${agent.name}:`, err);
      }
      break;
    }

    case "resource_sample": {
      // Strict validation: percentages must be 0-100, rates non-negative,
      // timestamp within sane window. Reject out-of-range rather than storing
      // nonsense that would poison dashboards.
      const inPct = (v: unknown): number | null => {
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        if (v < 0 || v > 100) return null;
        return v;
      };
      const inBps = (v: unknown): bigint | null => {
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        if (v < 0) return null;
        // Cap at ~10 TB/s so a runaway counter can't blow up BigInt.
        if (v > 1e13) return null;
        return BigInt(Math.round(v));
      };

      const cpuPct = inPct(msg.cpu_pct);
      const ramPct = inPct(msg.ram_pct);
      const diskPct = inPct(msg.disk_pct);
      if (cpuPct === null && ramPct === null && diskPct === null) {
        console.warn(`Dropping resource_sample from ${agent.name}: all metrics invalid`);
        break;
      }
      const loadAvg1 =
        typeof msg.load_avg_1 === "number" && Number.isFinite(msg.load_avg_1) && msg.load_avg_1 >= 0
          ? msg.load_avg_1
          : null;
      const netRxBps = inBps(msg.net_rx_bps);
      const netTxBps = inBps(msg.net_tx_bps);

      // Timestamp: accept within ±10min of server clock, else stamp server-side.
      let ts = new Date();
      if (typeof msg.timestamp === "string" && msg.timestamp.length > 0) {
        const parsed = Date.parse(msg.timestamp);
        if (!Number.isNaN(parsed)) {
          const skew = Math.abs(parsed - Date.now());
          if (skew < 10 * 60_000) ts = new Date(parsed);
        }
      }

      try {
        await db.resourceSample.create({
          data: {
            agentId: agent.id,
            timestamp: ts,
            cpuPct,
            ramPct,
            diskPct,
            loadAvg1,
            netRxBps,
            netTxBps,
          },
        });
      } catch (err) {
        console.warn(`Failed to insert resource_sample for ${agent.name}:`, err);
      }
      break;
    }

    case "health_report": {
      const bufferDepth =
        typeof msg.buffer_depth === "number" && Number.isFinite(msg.buffer_depth) && msg.buffer_depth >= 0
          ? Math.round(msg.buffer_depth)
          : null;
      const droppedEventsRaw = msg.dropped_events;
      const droppedEvents =
        typeof droppedEventsRaw === "number" && Number.isFinite(droppedEventsRaw) && droppedEventsRaw >= 0
          ? BigInt(Math.round(droppedEventsRaw))
          : null;
      const uptimeRaw = msg.uptime_secs;
      const uptimeSecs =
        typeof uptimeRaw === "number" && Number.isFinite(uptimeRaw) && uptimeRaw >= 0
          ? BigInt(Math.round(uptimeRaw))
          : null;

      if (bufferDepth === null && droppedEvents === null && uptimeSecs === null) {
        console.warn(`Dropping health_report from ${agent.name}: no valid fields`);
        break;
      }

      try {
        await db.agent.update({
          where: { id: agent.id },
          data: {
            ...(bufferDepth !== null ? { bufferDepth } : {}),
            ...(droppedEvents !== null ? { droppedEvents } : {}),
            ...(uptimeSecs !== null ? { uptimeSecs } : {}),
            lastSeen: new Date(),
          },
        });
      } catch (err) {
        console.warn(`Failed to update health for ${agent.name}:`, err);
      }
      break;
    }

    case "action_ack":
    case "action_denied": {
      // Agent is confirming (or refusing) a Hub-initiated action. We log it
      // and broadcast over SSE so any UI listeners can surface a toast.
      const action =
        typeof msg.action === "string" ? msg.action : "unknown";
      const checkId =
        typeof msg.check_id === "string" ? msg.check_id : null;
      const status =
        typeof msg.status === "string" ? msg.status : undefined;
      const reason =
        typeof msg.reason === "string" ? msg.reason : undefined;
      const accepted = type === "action_ack";

      console.log(
        `[agent-action] ${agent.name} ${type} action=${action}` +
          (checkId ? ` check=${checkId}` : "") +
          (status ? ` status=${status}` : "") +
          (reason ? ` reason=${reason}` : ""),
      );

      broadcast("agent_action", {
        agentId: agent.id,
        agentName: agent.name,
        action,
        checkId,
        accepted,
        status: status ?? (accepted ? "ok" : "denied"),
        reason,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    default:
      console.warn(`Unknown message type from ${agent.name}: ${type}`);
  }
}
