"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  Download,
  Gauge,
  KeyRound,
  PlayCircle,
  RefreshCw,
  Tag,
  Wifi,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast-provider";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

// Keep this type in sync with `SystemMetrics` in the route handler.
interface JobStatus {
  lastRunAt: string | null;
  nextRunEstimateAt: string;
  intervalMins: number;
}

interface SystemMetrics {
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    uptimeSecs: number;
    nodeVersion: string;
    platform: string;
    pid: number;
  };
  eventLoop: {
    meanMs: number;
    maxMs: number;
    p99Ms: number;
    sampleCount: number;
  };
  connections: {
    websocketAgents: number;
    sseClients: number;
    recentlyDisconnectedCount: number;
    connectedAgentNames: string[];
  };
  database: {
    reachable: boolean;
    latencyMs: number | null;
    totalAgents: number;
    totalChecks: number;
    totalResults24h: number;
    totalIncidents: number;
    totalUsers: number;
  };
  queues: {
    notificationDeliveriesPending: number;
    notificationDeliveriesFailed1h: number;
    notificationDeliveriesRetrying: number;
  };
  jobs: {
    certMonitor: JobStatus;
    expiryMonitor: JobStatus;
  };
  versions: {
    hubVersion: string;
    hubBuildSha: string;
    schemaDigest: string;
    agentVersionHistogram: Record<string, number>;
  };
  signing: {
    agentUpdatePubkeyFingerprint: string | null;
    resultSigningPinnedAgents: number;
  };
}

// ── Formatting helpers ──────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log10(bytes) / 3),
  );
  const value = bytes / Math.pow(1000, exponent);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[exponent]}`;
}

function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return "—";
  const future = delta < 0;
  const ms = Math.abs(delta);
  const sec = Math.round(ms / 1000);
  const format = (value: number, unit: string): string =>
    future ? `in ${value}${unit}` : `${value}${unit} ago`;
  if (sec < 60) return format(sec, "s");
  const min = Math.round(sec / 60);
  if (min < 60) return format(min, "m");
  const hr = Math.round(min / 60);
  if (hr < 24) return format(hr, "h");
  const day = Math.round(hr / 24);
  return format(day, "d");
}

function truncate(value: string, head = 10, tail = 0): string {
  if (value.length <= head + tail + 1) return value;
  if (tail === 0) return `${value.slice(0, head)}…`;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// ── Event-loop ring buffer (in-memory, persists while page is mounted) ─

interface LagSample {
  mean: number;
  p99: number;
  at: number;
}

const MAX_LAG_SAMPLES = 10;

function useLagHistory(latest: SystemMetrics | undefined): LagSample[] {
  const ringRef = useRef<LagSample[]>([]);
  const lastSeenRef = useRef<number>(0);

  if (latest) {
    // Only push when the sampleCount advances (i.e. the route actually returned
    // a new histogram window). Prevents React re-renders from bloating the ring.
    const now = Date.now();
    if (now - lastSeenRef.current > 1_000) {
      lastSeenRef.current = now;
      const next = [
        ...ringRef.current,
        {
          mean: latest.eventLoop.meanMs,
          p99: latest.eventLoop.p99Ms,
          at: now,
        },
      ];
      ringRef.current = next.slice(-MAX_LAG_SAMPLES);
    }
  }

  return ringRef.current;
}

// ── Sparkline ───────────────────────────────────────────────────────────

interface SparklineProps {
  values: number[];
  color: string;
  max?: number;
  label: string;
}

function Sparkline({ values, color, max, label }: SparklineProps): React.ReactElement {
  const width = 160;
  const height = 36;
  const padding = 2;
  if (values.length === 0) {
    return (
      <svg width={width} height={height} aria-label={`${label} (no data)`} role="img" />
    );
  }
  const safeMax = Math.max(max ?? 0, ...values, 1);
  const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = padding + i * step;
      const y = height - padding - (v / safeMax) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} aria-label={label} role="img">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
}

// ── Stat row helper ─────────────────────────────────────────────────────

interface StatRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

function StatRow({ label, value, mono }: StatRowProps): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-gray-100 py-1.5 last:border-b-0 dark:border-gray-800">
      <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </span>
      <span
        className={cn(
          "text-sm text-gray-900 dark:text-gray-100",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────

export default function AdminSystemPage(): React.ReactElement {
  const { data: session, isPending } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [agentsExpanded, setAgentsExpanded] = useState(false);

  const { data, error, isLoading, isFetching } = useQuery<SystemMetrics>({
    queryKey: ["admin", "system", "metrics"],
    queryFn: async () => {
      const res = await fetch("/api/admin/system/metrics");
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Failed to load metrics (${res.status})`,
        );
      }
      return (await res.json()) as SystemMetrics;
    },
    enabled: role === "admin",
    refetchInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? false
        : 10_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const lagHistory = useLagHistory(data);

  const runJob = useMutation({
    mutationFn: async (job: "cert" | "expiry") => {
      const res = await fetch(`/api/admin/system/run-job?name=${job}`, {
        method: "POST",
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        durationMs?: number;
        error?: string;
      };
      if (!res.ok || payload.ok === false) {
        throw new Error(payload.error ?? `Job failed (${res.status})`);
      }
      return payload;
    },
    onSuccess: (payload, job) => {
      toast.success(
        `Job "${job}" completed`,
        `Finished in ${payload.durationMs ?? 0}ms.`,
      );
      queryClient.invalidateQueries({ queryKey: ["admin", "system", "metrics"] });
    },
    onError: (err, job) => {
      toast.error(
        `Job "${job}" failed`,
        err instanceof Error ? err.message : String(err),
      );
    },
  });

  if (isPending) {
    return <Skeleton className="h-10 w-40" />;
  }
  if (role !== "admin") {
    return (
      <EmptyState
        title="Admin only"
        description="You need the admin role to view Hub system metrics."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Hub System
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Live process, database, queue, and job telemetry for the Vigil Hub.
            Polls every 10s while this tab is visible.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isFetching ? (
            <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Refreshing
            </span>
          ) : null}
          <Link
            href="/api/admin/system/diag-bundle"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            <Download className="h-4 w-4" />
            Export diagnostics bundle
          </Link>
        </div>
      </div>

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-rose-600 dark:text-rose-400">
            {error instanceof Error
              ? error.message
              : "Failed to load system metrics."}
          </CardContent>
        </Card>
      ) : null}

      {isLoading || !data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <ProcessCard metrics={data} />
          <EventLoopCard metrics={data} history={lagHistory} />
          <ConnectionsCard
            metrics={data}
            expanded={agentsExpanded}
            onToggle={() => setAgentsExpanded((v) => !v)}
          />
          <DatabaseCard metrics={data} />
          <QueuesCard metrics={data} />
          <JobsCard
            metrics={data}
            onRun={(job) => runJob.mutate(job)}
            runningJob={runJob.isPending ? runJob.variables ?? null : null}
          />
          <VersionsCard metrics={data} />
          <SigningCard metrics={data} />
        </div>
      )}
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────

function ProcessCard({ metrics }: { metrics: SystemMetrics }): React.ReactElement {
  const p = metrics.process;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-emerald-500" />
          Process
        </CardTitle>
        <CardDescription>
          Hub Node.js runtime and memory footprint
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <StatRow label="RSS" value={formatBytes(p.rssBytes)} />
        <StatRow
          label="Heap"
          value={`${formatBytes(p.heapUsedBytes)} / ${formatBytes(p.heapTotalBytes)}`}
        />
        <StatRow label="External" value={formatBytes(p.externalBytes)} />
        <StatRow label="Uptime" value={formatUptime(p.uptimeSecs)} />
        <StatRow label="Node" value={p.nodeVersion} mono />
        <StatRow label="Platform" value={p.platform} mono />
        <StatRow label="PID" value={p.pid.toString()} mono />
      </CardContent>
    </Card>
  );
}

interface EventLoopCardProps {
  metrics: SystemMetrics;
  history: LagSample[];
}

function EventLoopCard({ metrics, history }: EventLoopCardProps): React.ReactElement {
  const el = metrics.eventLoop;
  const meanSeries = history.map((h) => h.mean);
  const p99Series = history.map((h) => h.p99);
  const healthy = el.p99Ms < 50;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-emerald-500" />
          Event loop
          <Badge variant={healthy ? "ok" : el.p99Ms < 200 ? "warn" : "crit"}>
            {healthy ? "healthy" : el.p99Ms < 200 ? "lagging" : "stalled"}
          </Badge>
        </CardTitle>
        <CardDescription>Sampled at 20ms resolution, reset each poll</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <StatRow label="Mean" value={`${el.meanMs.toFixed(2)} ms`} />
          <StatRow label="P99" value={`${el.p99Ms.toFixed(2)} ms`} />
          <StatRow label="Max" value={`${el.maxMs.toFixed(2)} ms`} />
          <StatRow label="Samples" value={el.sampleCount.toLocaleString()} />
        </div>
        <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-950/50">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-gray-500">Mean (last {MAX_LAG_SAMPLES})</span>
            <Sparkline values={meanSeries} color="#10b981" label="event loop mean" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-gray-500">P99</span>
            <Sparkline values={p99Series} color="#f59e0b" label="event loop p99" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface ConnectionsCardProps {
  metrics: SystemMetrics;
  expanded: boolean;
  onToggle: () => void;
}

function ConnectionsCard({
  metrics,
  expanded,
  onToggle,
}: ConnectionsCardProps): React.ReactElement {
  const c = metrics.connections;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wifi className="h-4 w-4 text-emerald-500" />
          Connections
        </CardTitle>
        <CardDescription>
          Live WebSocket agents and SSE dashboard clients
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <StatRow
          label="WS agents"
          value={
            <Badge variant={c.websocketAgents > 0 ? "ok" : "muted"}>
              {c.websocketAgents}
            </Badge>
          }
        />
        <StatRow
          label="SSE clients"
          value={
            <Badge variant={c.sseClients > 0 ? "info" : "muted"}>
              {c.sseClients}
            </Badge>
          }
        />
        <StatRow
          label="Recently dropped"
          value={
            <Badge variant={c.recentlyDisconnectedCount > 0 ? "warn" : "muted"}>
              {c.recentlyDisconnectedCount}
            </Badge>
          }
        />
        <div className="pt-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center justify-between rounded-md bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:bg-gray-950/50 dark:text-gray-300 dark:hover:bg-gray-800/60"
            aria-expanded={expanded}
          >
            <span>{expanded ? "Hide" : "Show"} connected agents</span>
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {expanded ? (
            c.connectedAgentNames.length === 0 ? (
              <p className="mt-2 px-3 text-xs italic text-gray-500">
                No agents connected
              </p>
            ) : (
              <ul className="mt-2 space-y-0.5 px-3 text-xs text-gray-700 dark:text-gray-300">
                {c.connectedAgentNames.map((name) => (
                  <li key={name} className="font-mono">
                    {name}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
        <div className="pt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            title="Planned: disconnect idle SSE clients (P6.x follow-up)"
          >
            Disconnect idle SSE clients
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DatabaseCard({ metrics }: { metrics: SystemMetrics }): React.ReactElement {
  const d = metrics.database;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-4 w-4 text-emerald-500" />
          Database
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              d.reachable ? "bg-emerald-500" : "bg-rose-500",
            )}
            aria-label={d.reachable ? "Reachable" : "Unreachable"}
          />
        </CardTitle>
        <CardDescription>
          Postgres reachability and high-level row counts
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <StatRow
          label="Status"
          value={
            <Badge variant={d.reachable ? "ok" : "crit"}>
              {d.reachable ? "reachable" : "unreachable"}
            </Badge>
          }
        />
        <StatRow
          label="Latency"
          value={d.latencyMs === null ? "—" : `${d.latencyMs} ms`}
        />
        <StatRow label="Agents" value={d.totalAgents.toLocaleString()} />
        <StatRow label="Checks" value={d.totalChecks.toLocaleString()} />
        <StatRow
          label="Results (24h)"
          value={d.totalResults24h.toLocaleString()}
        />
        <StatRow label="Incidents" value={d.totalIncidents.toLocaleString()} />
        <StatRow label="Users" value={d.totalUsers.toLocaleString()} />
      </CardContent>
    </Card>
  );
}

function QueuesCard({ metrics }: { metrics: SystemMetrics }): React.ReactElement {
  const q = metrics.queues;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-500" />
          Notification queues
        </CardTitle>
        <CardDescription>Recent delivery attempt status</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3">
        <QueueCounter
          label="Pending"
          value={q.notificationDeliveriesPending}
          tone={q.notificationDeliveriesPending > 0 ? "info" : "muted"}
        />
        <QueueCounter
          label="Failed · 1h"
          value={q.notificationDeliveriesFailed1h}
          tone={q.notificationDeliveriesFailed1h > 0 ? "crit" : "ok"}
        />
        <QueueCounter
          label="Retrying"
          value={q.notificationDeliveriesRetrying}
          tone={q.notificationDeliveriesRetrying > 0 ? "warn" : "muted"}
        />
      </CardContent>
    </Card>
  );
}

function QueueCounter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "crit" | "info" | "muted";
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-gray-200 p-3 text-center dark:border-gray-800">
      <span className="text-2xl font-semibold text-gray-900 dark:text-white">
        {value}
      </span>
      <Badge variant={tone} className="mt-2">
        {label}
      </Badge>
    </div>
  );
}

interface JobsCardProps {
  metrics: SystemMetrics;
  onRun: (job: "cert" | "expiry") => void;
  runningJob: "cert" | "expiry" | null;
}

function JobsCard({ metrics, onRun, runningJob }: JobsCardProps): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlayCircle className="h-4 w-4 text-emerald-500" />
          Background jobs
        </CardTitle>
        <CardDescription>Certificate and expiry monitors</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <JobRow
          label="Cert monitor"
          status={metrics.jobs.certMonitor}
          busy={runningJob === "cert"}
          onRun={() => onRun("cert")}
        />
        <JobRow
          label="Expiry monitor"
          status={metrics.jobs.expiryMonitor}
          busy={runningJob === "expiry"}
          onRun={() => onRun("expiry")}
        />
      </CardContent>
    </Card>
  );
}

interface JobRowProps {
  label: string;
  status: JobStatus;
  busy: boolean;
  onRun: () => void;
}

function JobRow({ label, status, busy, onRun }: JobRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {label}
        </div>
        <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Last run: <span className="text-gray-700 dark:text-gray-200">{relativeTime(status.lastRunAt)}</span>
          {" · "}
          Next ~{relativeTime(status.nextRunEstimateAt)}
          {" · "}
          every {status.intervalMins}m
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRun}
        disabled={busy}
      >
        {busy ? (
          <RefreshCw className="h-3 w-3 animate-spin" />
        ) : (
          <PlayCircle className="h-3 w-3" />
        )}
        Run now
      </Button>
    </div>
  );
}

function VersionsCard({ metrics }: { metrics: SystemMetrics }): React.ReactElement {
  const v = metrics.versions;
  const histogramEntries = useMemo(
    () =>
      Object.entries(v.agentVersionHistogram).sort((a, b) => b[1] - a[1]),
    [v.agentVersionHistogram],
  );
  const total = histogramEntries.reduce((sum, [, count]) => sum + count, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="h-4 w-4 text-emerald-500" />
          Versions
        </CardTitle>
        <CardDescription>Hub build and connected agent distribution</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <StatRow label="Hub" value={v.hubVersion} mono />
          <StatRow label="Build SHA" value={truncate(v.hubBuildSha, 12)} mono />
          <StatRow label="Schema" value={truncate(v.schemaDigest, 12)} mono />
        </div>
        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">
            Agent versions
          </div>
          {histogramEntries.length === 0 ? (
            <p className="text-xs italic text-gray-500">No agents registered.</p>
          ) : (
            <div className="space-y-1.5">
              {histogramEntries.map(([version, count]) => {
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <div key={version} className="flex items-center gap-2">
                    <span className="w-24 truncate font-mono text-xs text-gray-700 dark:text-gray-300">
                      {version}
                    </span>
                    <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                      <div
                        className="absolute inset-y-0 left-0 bg-emerald-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-xs tabular-nums text-gray-600 dark:text-gray-300">
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SigningCard({ metrics }: { metrics: SystemMetrics }): React.ReactElement {
  const s = metrics.signing;
  const hasPubkey = s.agentUpdatePubkeyFingerprint !== null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-emerald-500" />
          Signing
        </CardTitle>
        <CardDescription>Update artifact & check-result integrity</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasPubkey ? (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs dark:border-emerald-900/60 dark:bg-emerald-950/40">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            <div>
              <div className="font-medium text-emerald-700 dark:text-emerald-300">
                Agent update pubkey pinned
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-emerald-800 dark:text-emerald-200">
                {s.agentUpdatePubkeyFingerprint}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900/60 dark:bg-amber-950/40">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <div className="font-medium text-amber-700 dark:text-amber-300">
                No update pubkey compiled
              </div>
              <div className="mt-1 text-amber-800 dark:text-amber-200">
                Agent auto-update will refuse signed releases until this is
                configured. See P6.3 rollout instructions.
              </div>
            </div>
          </div>
        )}
        <StatRow
          label="Pinned result signers"
          value={s.resultSigningPinnedAgents.toString()}
        />
      </CardContent>
    </Card>
  );
}

