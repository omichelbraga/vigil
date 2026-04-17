import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * Extract the client IP for audit logging.
 *
 * Trusts `x-forwarded-for` only when `VIGIL_TRUST_PROXY=1` is set (the server
 * is behind a known proxy that strips client-provided XFF). Otherwise XFF is
 * trivially spoofable and must be ignored.
 *
 * Falls back to NextRequest.ip, then the remote socket address, then "unknown".
 */
function extractIp(req: NextRequest): string | null {
  if (process.env.VIGIL_TRUST_PROXY === "1") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  const reqWithIp = req as unknown as { ip?: string };
  if (reqWithIp.ip) return reqWithIp.ip;

  const socket = (req as unknown as {
    socket?: { remoteAddress?: string };
  }).socket;
  if (socket?.remoteAddress) return socket.remoteAddress;

  return null;
}

function extractUserAgent(req: NextRequest): string | null {
  const ua = req.headers.get("user-agent");
  return ua && ua.length > 0 ? ua.slice(0, 512) : null;
}

/** Derive the `resource` (noun) from a `verb.noun` action string. */
function deriveResource(action: string): string {
  const dot = action.indexOf(".");
  if (dot < 0 || dot === action.length - 1) return action;
  return action.slice(dot + 1);
}

export interface AuditOptions {
  /** Overrides the auto-derived `resource`. Persisted verbatim. */
  entityType?: string;
  /** Identifier of the mutated entity (stored in metadata.entityId). */
  entityId?: string;
  /** Arbitrary extra context (merged into metadata). */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Write a row to the audit log. Fire-and-forget: any DB error is logged but
 * never thrown, so callers can safely place this immediately after a
 * successful mutation without fear of breaking the response path.
 *
 * @param req NextRequest — used to pull IP and user-agent headers.
 * @param actorId Better Auth user id, or `null` for system/anonymous events.
 * @param action verb.noun format, e.g. "user.invite", "agent.delete".
 * @param opts Optional entityType override, entityId, and extra metadata.
 */
export async function audit(
  req: NextRequest,
  actorId: string | null,
  action: string,
  opts: AuditOptions = {},
): Promise<void> {
  const ip = extractIp(req);
  const ua = extractUserAgent(req);
  const resource = opts.entityType ?? deriveResource(action);

  // Shape metadata — keep it a plain JSON object so downstream filters work.
  const baseMeta: Record<string, unknown> = {};
  if (opts.entityId) baseMeta.entityId = opts.entityId;
  if (ua) baseMeta.userAgent = ua;
  if (opts.metadata && typeof opts.metadata === "object" && !Array.isArray(opts.metadata)) {
    Object.assign(baseMeta, opts.metadata as Record<string, unknown>);
  } else if (opts.metadata !== undefined) {
    baseMeta.payload = opts.metadata;
  }

  try {
    await db.auditLog.create({
      data: {
        userId: actorId,
        action,
        resource,
        ipAddress: ip,
        metadata: baseMeta as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Never throw from audit — a failed log must not break the mutating request.
    // eslint-disable-next-line no-console
    console.error("[audit] failed to persist log", {
      action,
      resource,
      actorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
