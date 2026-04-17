import { monitorEventLoopDelay, IntervalHistogram } from "perf_hooks";

/**
 * Shared event-loop delay histogram for /api/admin/system/metrics.
 *
 * Created & enabled at module load. Each metrics read should snapshot the
 * current percentiles and then call `.reset()` so the next poll sees a fresh
 * 10-second window. Keeping a single shared instance avoids leaking a new
 * histogram every time the route is compiled/reloaded.
 */
let histogram: IntervalHistogram | null = null;

export function getEventLoopHistogram(): IntervalHistogram {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  }
  return histogram;
}

// Eager-init at module load so we start collecting as soon as the process boots.
getEventLoopHistogram();

// ── Job lastRun tracking ────────────────────────────────────────────────
// The metrics endpoint needs to know when runCertChecks / runExpiryChecks
// last completed. Rather than touching server.ts, we expose `markJobRun` and
// `getJobLastRun` — server.ts can optionally call `markJobRun` after each
// iteration, or admins can trigger via POST /api/admin/system/run-job which
// also calls `markJobRun`. If neither has happened yet, we report `null`.

export type JobName = "cert" | "expiry";

interface JobState {
  lastRunAt: number | null; // epoch ms
}

const jobState: Record<JobName, JobState> = {
  cert: { lastRunAt: null },
  expiry: { lastRunAt: null },
};

export function markJobRun(name: JobName, at: Date = new Date()): void {
  jobState[name].lastRunAt = at.getTime();
}

export function getJobLastRun(name: JobName): Date | null {
  const ts = jobState[name].lastRunAt;
  return ts ? new Date(ts) : null;
}

// ── Schema digest cache ─────────────────────────────────────────────────
// Computed once per process. Exposed via `setSchemaDigest` / `getSchemaDigest`
// so the metrics route can lazily populate on first request.

let schemaDigest: string | null = null;

export function setSchemaDigest(digest: string): void {
  schemaDigest = digest;
}

export function getSchemaDigest(): string | null {
  return schemaDigest;
}
