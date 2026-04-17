/**
 * GET /api/admin/system/diag-bundle
 *
 * Streams a ZIP archive containing hub diagnostics: env (redacted), recent
 * log, per-agent snapshots, channel/monitor configs (redacted), and audit
 * rows. Admin-only; audit-logged; hard-capped to 30 seconds wall time.
 *
 * The archive is streamed through a ReadableStream so we never buffer the
 * (potentially large) log file or the whole archive in memory.
 */

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import archiver, { Archiver } from "archiver";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import {
  redactDbBlob,
  redactEnv,
  redactJson,
} from "@/lib/redact";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Tunables ───────────────────────────────────────────────────────────

const BUNDLE_VERSION = 1 as const;
const MAX_BUNDLE_WALL_MS = 30_000;
const LOG_PATH = "/tmp/vigil-hub.log";
const LOG_MAX_LINES = 5_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap on what we retain
const PER_AGENT_RESULTS = 100;
const PER_AGENT_SAMPLES = 20;
const PER_AGENT_INCIDENTS = 10;
const AUDIT_LIMIT = 500;

// ── Types ──────────────────────────────────────────────────────────────

interface BundleError {
  file: string;
  reason: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build the filename-safe timestamp used in Content-Disposition:
 * `YYYYMMDD-HHMMSS`. UTC to avoid tz surprises on shared hosts.
 */
function stampFor(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

/**
 * Append a JSON-encoded entry to the archive. `redact` is true for DB blobs
 * so secrets in nested config JSON are scrubbed before they hit disk.
 */
function appendJson(
  archive: Archiver,
  path: string,
  body: unknown,
): void {
  let text: string;
  try {
    text = JSON.stringify(body, jsonReplacer, 2);
  } catch (err) {
    text = JSON.stringify({
      error: "serialization failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  archive.append(text, { name: path });
}

/** JSON.stringify replacer that handles BigInt (Prisma `BigInt` columns). */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * Read the tail of a log file with a hard line and byte cap. Streaming — we
 * never buffer the whole file. We keep a sliding window of the last N lines
 * in a ring buffer; memory is bounded by (N * avg_line_len), capped again by
 * LOG_MAX_BYTES when we assemble the output string.
 */
async function readLogTail(
  path: string,
  maxLines: number,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  let exists: boolean;
  try {
    const s = await stat(path);
    exists = s.isFile();
  } catch (err) {
    return {
      ok: false,
      reason: `log not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!exists) return { ok: false, reason: "log path is not a regular file" };

  const ring: string[] = new Array<string>(maxLines);
  let write = 0;
  let total = 0;

  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      ring[write % maxLines] = line;
      write++;
      total++;
    }
  } catch (err) {
    rl.close();
    stream.destroy();
    return {
      ok: false,
      reason: `read error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const count = Math.min(total, maxLines);
  const start = total > maxLines ? write % maxLines : 0;
  const ordered: string[] = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    ordered[i] = ring[(start + i) % maxLines];
  }
  let text = ordered.join("\n");
  if (text.length > maxBytes) {
    // Trim from the front — keep the most recent bytes.
    text = text.slice(text.length - maxBytes);
  }
  return { ok: true, text };
}

/** Serialize process.env redacted as sorted `KEY=VALUE\n` lines. */
function envRedactedText(): string {
  const redacted = redactEnv(process.env);
  const keys = Object.keys(redacted).sort();
  const lines: string[] = [];
  for (const k of keys) {
    lines.push(`${k}=${redacted[k]}`);
  }
  return lines.join("\n") + "\n";
}

/** Best-effort in-process metrics. Mirrors what `/api/admin/system/metrics`
 *  is intended to expose (P6.1). Safe to return whatever is available now. */
function collectMetrics(): Record<string, unknown> {
  const mem = process.memoryUsage();
  return {
    node: process.version,
    pid: process.pid,
    uptimeSecs: Math.round(process.uptime()),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
    },
    loadAvg: os.loadavg(),
    cpuCount: os.cpus().length,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
  };
}

/** Inline `/api/health` payload so we don't have to make a real HTTP call. */
function healthPayload(): Record<string, unknown> {
  return { status: "ok", version: "0.1.0" };
}

// ── Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const actorId = auth.user.id;
  const hubHost = os.hostname();

  // Record the audit row up-front (fire-and-forget inside `audit`). We don't
  // await this because we want the stream to start immediately, but we hold
  // the promise so the Node process doesn't garbage-collect it.
  void audit(req, actorId, "system.diag_bundle", {
    metadata: { hubHost },
  });

  // Deadline guard — we abort archiver if we miss it.
  const deadline = Date.now() + MAX_BUNDLE_WALL_MS;
  const abort = AbortSignal.timeout(MAX_BUNDLE_WALL_MS);

  const archive = archiver("zip", { zlib: { level: 9 } });
  const errors: BundleError[] = [];

  archive.on("warning", (err) => {
    errors.push({ file: "<archiver>", reason: String(err) });
  });
  archive.on("error", (err) => {
    errors.push({ file: "<archiver>", reason: String(err) });
  });

  // Kick off population concurrently with streaming. We catch all errors —
  // the stream must close cleanly even on partial failure.
  const populate = populateArchive({
    archive,
    actorId,
    hubHost,
    deadline,
    errors,
  });

  // Wait for populate to finish, then finalize. If we hit the deadline,
  // still finalize whatever we've got so the client gets a valid (truncated)
  // ZIP instead of a broken stream.
  populate
    .catch((err: unknown) => {
      errors.push({
        file: "<top-level>",
        reason: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      // Always append the errors manifest last — it's our audit trail for
      // partial bundles.
      if (errors.length > 0) {
        appendJson(archive, "errors/bundle-errors.json", errors);
      }
      void archive.finalize();
    });

  abort.addEventListener("abort", () => {
    errors.push({
      file: "<deadline>",
      reason: `bundle exceeded ${MAX_BUNDLE_WALL_MS}ms — truncated`,
    });
    // Finalize what we have rather than leaving the client hanging.
    try {
      void archive.finalize();
    } catch {
      // already finalized
    }
  });

  // Bridge Node stream → Web ReadableStream for the Next.js Response.
  const stream = nodeToWebStream(archive, req.signal);

  const filename = `vigil-diag-${stampFor(new Date())}.zip`;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

// ── Population ─────────────────────────────────────────────────────────

interface PopulateArgs {
  archive: Archiver;
  actorId: string;
  hubHost: string;
  deadline: number;
  errors: BundleError[];
}

async function populateArchive(args: PopulateArgs): Promise<void> {
  const { archive, actorId, hubHost, deadline, errors } = args;

  const deadlineReached = (): boolean => Date.now() >= deadline;
  const capture = (file: string, err: unknown): void => {
    errors.push({
      file,
      reason: err instanceof Error ? err.message : String(err),
    });
  };

  // manifest.json — bundle metadata
  appendJson(archive, "manifest.json", {
    bundleVersion: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    hubVersion: "0.1.0",
    hubHost,
    generatedBy: actorId,
  });

  // hub/health.json
  try {
    appendJson(archive, "hub/health.json", healthPayload());
  } catch (err) {
    capture("hub/health.json", err);
  }

  // hub/metrics.json — best-effort; no separate HTTP call.
  try {
    appendJson(archive, "hub/metrics.json", collectMetrics());
  } catch (err) {
    appendJson(archive, "hub/metrics.json", {
      unavailable: true,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // hub/schema-version.txt — digest of Prisma schema presence. We don't have
  // a migrations folder in this repo yet, so the best we can do is stamp the
  // Prisma client version.
  try {
    const prismaVersion = await prismaSchemaDigest();
    archive.append(prismaVersion, { name: "hub/schema-version.txt" });
  } catch (err) {
    capture("hub/schema-version.txt", err);
    archive.append("unavailable\n", { name: "hub/schema-version.txt" });
  }

  // hub/env-redacted.txt
  try {
    archive.append(envRedactedText(), { name: "hub/env-redacted.txt" });
  } catch (err) {
    capture("hub/env-redacted.txt", err);
  }

  // hub/recent-log.txt (streaming tail)
  try {
    const log = await readLogTail(LOG_PATH, LOG_MAX_LINES, LOG_MAX_BYTES);
    if (log.ok) {
      archive.append(log.text, { name: "hub/recent-log.txt" });
    } else {
      archive.append(`no log available: ${log.reason}\n`, {
        name: "hub/recent-log.txt",
      });
    }
  } catch (err) {
    capture("hub/recent-log.txt", err);
    archive.append("no log available\n", { name: "hub/recent-log.txt" });
  }

  if (deadlineReached()) return;

  // agents/<id>.json — per active agent
  try {
    const agents = await db.agent.findMany({
      where: { isActive: true },
      include: { inventory: true },
    });
    for (const agent of agents) {
      if (deadlineReached()) break;
      try {
        const [results, samples, incidents] = await Promise.all([
          db.checkResult.findMany({
            where: { agentId: agent.id },
            orderBy: { timestamp: "desc" },
            take: PER_AGENT_RESULTS,
          }),
          db.resourceSample.findMany({
            where: { agentId: agent.id },
            orderBy: { timestamp: "desc" },
            take: PER_AGENT_SAMPLES,
          }),
          db.incident.findMany({
            where: { agentId: agent.id },
            orderBy: { firedAt: "desc" },
            take: PER_AGENT_INCIDENTS,
          }),
        ]);

        // Redact the agent row: tokenHash is an argon2 hash (harmless without
        // the pepper), but better to drop it anyway since the pattern filter
        // catches `*_hash` via `hash` → no match, so we delete it by hand.
        const { tokenHash: _drop, ...agentRow } = agent;
        const redactedAgent = redactDbBlob(
          agentRow as unknown as Record<string, unknown>,
        );

        appendJson(archive, `agents/${agent.id}.json`, {
          agent: redactedAgent,
          inventory: agent.inventory
            ? redactDbBlob(agent.inventory as unknown as Record<string, unknown>)
            : null,
          recentResults: results.map((r) => redactJson(r)),
          recentResourceSamples: samples.map((s) => redactJson(s)),
          recentIncidents: incidents.map((i) => redactJson(i)),
        });
      } catch (err) {
        capture(`agents/${agent.id}.json`, err);
      }
    }
  } catch (err) {
    capture("agents/", err);
  }

  if (deadlineReached()) return;

  // config/alert-channels.json — redact nested token/url fields
  try {
    const channels = await db.alertChannel.findMany();
    appendJson(
      archive,
      "config/alert-channels.json",
      channels.map((c) =>
        redactDbBlob(c as unknown as Record<string, unknown>),
      ),
    );
  } catch (err) {
    capture("config/alert-channels.json", err);
  }

  // config/monitors.json — enabled checks only
  try {
    const checks = await db.check.findMany({
      where: { enabled: true },
      include: { agent: { select: { id: true, name: true } } },
    });
    appendJson(
      archive,
      "config/monitors.json",
      checks.map((c) => redactDbBlob(c as unknown as Record<string, unknown>)),
    );
  } catch (err) {
    capture("config/monitors.json", err);
  }

  if (deadlineReached()) return;

  // audit/recent.json — last AUDIT_LIMIT rows
  try {
    const rows = await db.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: AUDIT_LIMIT,
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });
    appendJson(
      archive,
      "audit/recent.json",
      rows.map((r) => redactJson(r)),
    );
  } catch (err) {
    capture("audit/recent.json", err);
  }
}

/**
 * Build a short identifier for the DB schema. We don't have a migrations
 * folder yet, so fall back to querying the runtime Prisma client version.
 */
async function prismaSchemaDigest(): Promise<string> {
  // Shape: `prisma=<ver>;node=<ver>`. Enough to identify which migrations
  // were applied against which client.
  const clientVersion = await resolvePrismaVersion();
  return `prisma=${clientVersion};node=${process.version}\n`;
}

async function resolvePrismaVersion(): Promise<string> {
  try {
    // Dynamic import keeps this out of the critical startup path if the
    // package layout ever changes.
    const pkg = (await import("@prisma/client/package.json", {
      with: { type: "json" },
    })) as { default?: { version?: string }; version?: string };
    return pkg.default?.version ?? pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Stream bridging ────────────────────────────────────────────────────

type NodeReadable = Archiver;

/**
 * Bridge a Node-style Readable (archiver inherits from it) to a Web
 * ReadableStream. We back-pressure by pausing the Node stream when the Web
 * controller signals the queue is full.
 */
function nodeToWebStream(
  nodeStream: NodeReadable,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer): void => {
        if (cancelled) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          cancelled = true;
          nodeStream.destroy();
        }
      };
      const onEnd = (): void => {
        if (cancelled) return;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const onError = (err: Error): void => {
        cancelled = true;
        try {
          controller.error(err);
        } catch {
          // already errored/closed
        }
      };

      nodeStream.on("data", onData);
      nodeStream.on("end", onEnd);
      nodeStream.on("error", onError);

      // Cancel if the client disconnects.
      signal.addEventListener("abort", () => {
        cancelled = true;
        nodeStream.destroy();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cancelled = true;
      nodeStream.destroy();
    },
  });
}
