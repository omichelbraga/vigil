import os from "os";
import { db } from "./db";
import { sendAgentMessage, getConnectedAgentIds } from "./ws-server";
import {
  resolveTargetAgents,
  type RolloutTargetFilter,
} from "./rollout-target";

/**
 * Staged rollout orchestration (P6.5).
 *
 * Every tick (`TICK_INTERVAL_MS`), walk all `running` jobs and decide whether
 * to advance — either send the canary, start the next batch, or mark a job
 * complete/paused based on in-flight attempts.
 *
 * State machine per job:
 *   queued → running → (canary) → batches → completed
 *                              \→ paused (any attempt failed, or a batch stalled)
 *   any → failed (cancel + skip pending)
 *
 * Safety rails (these cannot be overridden):
 *   - A release without `sha256` or `signature` is never pushed.
 *   - The agent whose hostname matches this Hub's hostname is NEVER targeted.
 *   - Attempts that don't complete within `ATTEMPT_TIMEOUT_MS` are force-failed
 *     and the job auto-paused.
 *   - If a batch doesn't finish in `2 * batchDelaySecs * 1000`, the job pauses.
 */

const TICK_INTERVAL_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_SECS = 600; // 10 minutes

function getAttemptTimeoutMs(): number {
  const raw = process.env.VIGIL_ROLLOUT_ATTEMPT_TIMEOUT_SECS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 5 && n <= 86_400) {
      return n * 1000;
    }
  }
  return DEFAULT_ATTEMPT_TIMEOUT_SECS * 1000;
}

declare global {
  // eslint-disable-next-line no-var
  var _vigilRolloutRunnerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var _vigilRolloutBatchStartedAt: Map<string, number> | undefined;
}

/**
 * Per-job last batch start time — used to detect a stalled batch that exceeds
 * `2 * batchDelaySecs`. Keyed by jobId. Resets when a batch completes.
 */
const batchStartedAt: Map<string, number> =
  global._vigilRolloutBatchStartedAt ??
  (global._vigilRolloutBatchStartedAt = new Map());

/** Start the scheduler loop. Safe to call many times — subsequent calls no-op. */
export function startRolloutRunner(): void {
  if (global._vigilRolloutRunnerStarted) return;
  global._vigilRolloutRunnerStarted = true;
  // Fire once on startup so recovery from a hub restart is immediate.
  void tick().catch((err) => console.error("[rollout-runner] tick error:", err));
  setInterval(() => {
    void tick().catch((err) => console.error("[rollout-runner] tick error:", err));
  }, TICK_INTERVAL_MS);
  console.log(
    `[rollout-runner] started — tick=${TICK_INTERVAL_MS}ms, attemptTimeout=${getAttemptTimeoutMs()}ms`,
  );
}

async function tick(): Promise<void> {
  const jobs = await db.rolloutJob.findMany({
    where: { status: "running" },
    include: {
      release: true,
      attempts: true,
    },
  });

  for (const job of jobs) {
    try {
      await advanceJob(job);
    } catch (err) {
      console.error(`[rollout-runner] job ${job.id} error:`, err);
    }
  }
}

type JobWithRelation = Awaited<ReturnType<typeof db.rolloutJob.findFirst>>;

async function advanceJob(
  job: NonNullable<JobWithRelation> & {
    release: NonNullable<Awaited<ReturnType<typeof db.agentRelease.findFirst>>>;
    attempts: Awaited<ReturnType<typeof db.rolloutAttempt.findMany>>;
  },
): Promise<void> {
  // ── Safety gate: refuse to dispatch for un-signed or missing-sha releases.
  if (!job.release.sha256 || !job.release.signature) {
    await pauseJob(
      job.id,
      `Release ${job.release.id} is missing sha256 or signature — refusing to push.`,
    );
    return;
  }

  const timeoutMs = getAttemptTimeoutMs();
  const now = Date.now();
  const filter = (job.targetFilter ?? {}) as RolloutTargetFilter;

  // ── Step 1: reconcile in-flight attempts (timeouts → failed)
  const inflight = job.attempts.filter((a) => a.status === "in_progress");
  for (const att of inflight) {
    const started = att.startedAt.getTime();
    if (now - started > timeoutMs) {
      await db.rolloutAttempt.update({
        where: { id: att.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: att.error ?? `Timed out waiting for reconnect after ${timeoutMs}ms`,
        },
      });
      await db.rolloutJob.update({
        where: { id: job.id },
        data: { failureCount: { increment: 1 } },
      });
      console.warn(
        `[rollout-runner] job=${job.id} agent=${att.agentId} attempt timed out`,
      );
    }
  }

  // ── Refetch after timeout reconciliation so downstream logic is consistent
  const refreshed = await db.rolloutJob.findUnique({
    where: { id: job.id },
    include: { release: true, attempts: true },
  });
  if (!refreshed) return;

  // Auto-pause on any failure
  if (refreshed.attempts.some((a) => a.status === "failed")) {
    await pauseJob(
      refreshed.id,
      "Auto-paused: one or more agents failed to update.",
    );
    return;
  }

  const openAttempts = refreshed.attempts.filter(
    (a) => a.status === "pending" || a.status === "in_progress",
  );

  // ── Step 2: canary — run first if configured
  if (refreshed.canaryAgentId) {
    const canaryAttempt = refreshed.attempts.find(
      (a) => a.agentId === refreshed.canaryAgentId,
    );
    if (!canaryAttempt) {
      await startCanary(refreshed);
      return;
    }
    if (canaryAttempt.status === "pending" || canaryAttempt.status === "in_progress") {
      // Wait for canary to finish before starting batches.
      return;
    }
    // Success → fall through to batch progression.
  }

  // ── Step 3: stalled-batch detector
  if (openAttempts.length > 0) {
    const batchStart = batchStartedAt.get(refreshed.id);
    if (batchStart && now - batchStart > 2 * refreshed.batchDelaySecs * 1000) {
      await pauseJob(
        refreshed.id,
        `Batch stalled — no progress in ${2 * refreshed.batchDelaySecs}s.`,
      );
      return;
    }
    // Batch still progressing; nothing to dispatch this tick.
    return;
  }

  // ── Step 4: start the next batch
  const targets = await resolveTargetAgents(
    filter,
    refreshed.release,
    { excludeJobId: refreshed.id },
  );

  // Filter connected + not-hub
  const hubName = os.hostname();
  const connected = getConnectedAgentIds();
  const eligible = targets.filter((t) => {
    if (t.hostname && t.hostname === hubName) return false; // never self-update
    if (!connected.has(t.id)) return false; // only connected agents can receive the msg
    return true;
  });

  if (eligible.length === 0) {
    // Check whether there are any remaining offline targets. If everything is
    // either on the target version or completed, mark the job done. Otherwise
    // keep running — maybe they come online.
    const remaining = await resolveTargetAgents(filter, refreshed.release, {
      excludeJobId: refreshed.id,
    });
    if (remaining.length === 0) {
      await db.rolloutJob.update({
        where: { id: refreshed.id },
        data: { status: "completed", completedAt: new Date() },
      });
      batchStartedAt.delete(refreshed.id);
      console.log(`[rollout-runner] job=${refreshed.id} completed`);
    }
    return;
  }

  const batch = eligible.slice(0, refreshed.batchSize);
  batchStartedAt.set(refreshed.id, now);
  for (const target of batch) {
    await dispatchUpdate(refreshed, target);
  }
}

async function startCanary(job: {
  id: string;
  canaryAgentId: string | null;
  release: NonNullable<Awaited<ReturnType<typeof db.agentRelease.findFirst>>>;
}): Promise<void> {
  if (!job.canaryAgentId) return;
  const agent = await db.agent.findUnique({
    where: { id: job.canaryAgentId },
    select: { id: true, name: true, version: true, hostname: true },
  });
  if (!agent) {
    await pauseJob(job.id, `Canary agent ${job.canaryAgentId} not found.`);
    return;
  }
  const hubName = os.hostname();
  if (agent.hostname && agent.hostname === hubName) {
    await pauseJob(
      job.id,
      `Refusing to canary the Hub's own host (${agent.hostname}).`,
    );
    return;
  }

  await dispatchUpdate(job, {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    hostname: agent.hostname,
  });
  console.log(`[rollout-runner] job=${job.id} canary dispatched to ${agent.name}`);
}

interface AgentForDispatch {
  id: string;
  name: string;
  version: string | null;
  hostname: string | null;
}

async function dispatchUpdate(
  job: {
    id: string;
    release: NonNullable<Awaited<ReturnType<typeof db.agentRelease.findFirst>>>;
  },
  agent: AgentForDispatch,
): Promise<void> {
  const release = job.release;
  if (!release.sha256 || !release.signature) {
    // Double-guard — advanceJob should have paused already, but belt-and-braces.
    return;
  }

  const baseUrl =
    process.env.VIGIL_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_HUB_URL ||
    process.env.HUB_URL ||
    "";
  // Agent-side download_url should reach the existing streaming endpoint.
  const downloadUrl = `${baseUrl.replace(/\/$/, "")}/api/update/agent/${encodeURIComponent(
    release.os,
  )}/${encodeURIComponent(release.arch)}/download`;

  // Insert (or promote) the attempt row BEFORE sending so a crash between
  // send and DB write doesn't strand an agent in limbo.
  const existing = await db.rolloutAttempt.findFirst({
    where: { jobId: job.id, agentId: agent.id },
  });
  if (existing && existing.status !== "pending") {
    // Already handled — don't re-dispatch.
    return;
  }
  if (existing) {
    await db.rolloutAttempt.update({
      where: { id: existing.id },
      data: {
        status: "in_progress",
        versionBefore: agent.version,
        startedAt: new Date(),
        error: null,
      },
    });
  } else {
    await db.rolloutAttempt.create({
      data: {
        jobId: job.id,
        agentId: agent.id,
        status: "in_progress",
        versionBefore: agent.version,
        startedAt: new Date(),
      },
    });
  }

  const sent = sendAgentMessage(agent.id, {
    type: "update_now",
    version: release.version,
    download_url: downloadUrl,
    sha256: release.sha256,
    signature: release.signature,
  });

  if (!sent) {
    // Agent went offline between the connected-check and the send. Mark pending
    // again so the next tick retries.
    await db.rolloutAttempt.updateMany({
      where: { jobId: job.id, agentId: agent.id, status: "in_progress" },
      data: {
        status: "pending",
        error: "Agent disconnected before update_now could be sent.",
      },
    });
    console.warn(
      `[rollout-runner] job=${job.id} agent=${agent.name} disconnected during send`,
    );
  } else {
    console.log(
      `[rollout-runner] job=${job.id} → ${agent.name} update_now v${release.version}`,
    );
  }
}

async function pauseJob(jobId: string, reason: string): Promise<void> {
  await db.rolloutJob.update({
    where: { id: jobId },
    data: { status: "paused" },
  });
  batchStartedAt.delete(jobId);
  console.warn(`[rollout-runner] job=${jobId} auto-paused: ${reason}`);
}

/**
 * Called from ws-server when an agent reconnects. If this agent has an
 * in-flight RolloutAttempt and its reported version matches the release
 * version, mark the attempt `success` and bump job.successCount.
 *
 * Idempotent — called at most once per agent connect. Safe for concurrent
 * reconnects from multiple agents.
 */
export async function handleAgentReconnectForRollouts(
  agentId: string,
  reportedVersion: string | null,
): Promise<void> {
  if (!reportedVersion) return;
  const attempt = await db.rolloutAttempt.findFirst({
    where: {
      agentId,
      status: "in_progress",
    },
    orderBy: { startedAt: "desc" },
    include: {
      job: { include: { release: true } },
    },
  });
  if (!attempt) return;
  const release = attempt.job.release;
  if (reportedVersion !== release.version) {
    // Not the target version yet — the agent either didn't install or is still
    // mid-swap. The timeout path will eventually catch non-progressing attempts.
    return;
  }
  try {
    await db.$transaction(async (tx) => {
      await tx.rolloutAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "success",
          completedAt: new Date(),
          versionAfter: reportedVersion,
        },
      });
      await tx.rolloutJob.update({
        where: { id: attempt.jobId },
        data: { successCount: { increment: 1 } },
      });
    });
    console.log(
      `[rollout-runner] attempt=${attempt.id} SUCCESS (${agentId} → ${reportedVersion})`,
    );
  } catch (err) {
    console.error(
      `[rollout-runner] failed to mark attempt success for ${agentId}:`,
      err,
    );
  }
}
