"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  XCircle,
  Pause,
  Package,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

interface AttemptRow {
  id: string;
  agentId: string;
  agentName: string | null;
  status: string;
  versionBefore: string | null;
  versionAfter: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface RolloutDetail {
  id: string;
  status: string;
  release: {
    id: string;
    os: string;
    arch: string;
    version: string;
    sha256: string;
    signature: string | null;
    signedBy: string | null;
    isActive: boolean;
  };
  targetFilter: {
    os?: string;
    arch?: string;
    tags?: string[];
    agentIds?: string[];
  };
  targetsTotal: number;
  batchSize: number;
  batchDelaySecs: number;
  canaryAgentId: string | null;
  successCount: number;
  failureCount: number;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attempts: AttemptRow[];
}

function statusVariant(s: string): "ok" | "warn" | "crit" | "info" | "muted" {
  if (s === "running" || s === "in_progress") return "info";
  if (s === "completed" || s === "success") return "ok";
  if (s === "failed") return "crit";
  if (s === "paused") return "warn";
  if (s === "skipped") return "muted";
  if (s === "pending") return "warn";
  return "muted";
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function durationSecs(startIso: string, endIso: string | null): string {
  if (!endIso) return "—";
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export default function RolloutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.ReactElement {
  const { id } = use(params);
  const { data: session, isPending } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;

  const detailQuery = useQuery<RolloutDetail>({
    queryKey: ["admin", "rollouts", id],
    queryFn: () => fetchJson<RolloutDetail>(`/api/admin/rollouts/${id}`),
    enabled: role === "admin",
    refetchInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? false
        : 5_000,
  });

  if (isPending) return <Skeleton className="h-10 w-40" />;
  if (role !== "admin") {
    return (
      <EmptyState title="Admin only" description="You need the admin role to view this page." />
    );
  }
  if (detailQuery.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (detailQuery.error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-600 dark:text-rose-400">
          {detailQuery.error instanceof Error
            ? detailQuery.error.message
            : "Failed to load rollout."}
        </CardContent>
      </Card>
    );
  }
  const d = detailQuery.data;
  if (!d) return <EmptyState title="Not found" description="Rollout does not exist." />;

  const processed = d.successCount + d.failureCount;
  const pct = d.targetsTotal > 0 ? Math.min(100, (processed / d.targetsTotal) * 100) : 0;
  const signed = !!d.release.signature;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link
          href="/admin/rollouts"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to rollouts
        </Link>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-4 w-4 text-emerald-500" />
                {d.release.os}/{d.release.arch} v{d.release.version}
              </CardTitle>
              <CardDescription>
                Rollout <span className="font-mono">{d.id}</span>
              </CardDescription>
            </div>
            <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
              <span>
                {d.successCount} success · {d.failureCount} failed · {d.targetsTotal} targets
              </span>
              <span className="tabular-nums">{pct.toFixed(0)}%</span>
            </div>
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
              <div
                className="absolute inset-y-0 left-0 bg-emerald-500 transition-all"
                style={{ width: `${pct}%` }}
              />
              {d.failureCount > 0 ? (
                <div
                  className="absolute inset-y-0 bg-rose-500"
                  style={{
                    left: `${(d.successCount / Math.max(d.targetsTotal, 1)) * 100}%`,
                    width: `${(d.failureCount / Math.max(d.targetsTotal, 1)) * 100}%`,
                  }}
                />
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <InfoRow label="Batch size" value={d.batchSize.toString()} />
            <InfoRow label="Batch delay" value={`${d.batchDelaySecs}s`} />
            <InfoRow label="Canary" value={d.canaryAgentId ? "yes" : "no"} />
            <InfoRow label="Created by" value={d.createdByEmail ?? "—"} />
            <InfoRow label="Created" value={formatDate(d.createdAt)} />
            <InfoRow label="Started" value={formatDate(d.startedAt)} />
            <InfoRow label="Completed" value={formatDate(d.completedAt)} />
            <InfoRow
              label="Release signed"
              value={
                signed ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {d.release.signedBy ?? "yes"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                    <ShieldOff className="h-3.5 w-3.5" />
                    unsigned
                  </span>
                )
              }
            />
          </div>

          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
              Target filter
            </div>
            <pre className="overflow-x-auto rounded-md bg-gray-50 p-3 text-xs dark:bg-gray-950/40">
              {JSON.stringify(d.targetFilter, null, 2)}
            </pre>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attempts ({d.attempts.length})</CardTitle>
          <CardDescription>
            Every agent the runner has targeted for this rollout, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {d.attempts.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No attempts yet"
                description="The runner will dispatch update_now to agents on its next tick (≤30s)."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-3">Agent</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Version</th>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {d.attempts.map((a) => (
                    <tr key={a.id}>
                      <td className="px-4 py-3">
                        <Link
                          href={`/agents/${a.agentId}`}
                          className="font-medium text-gray-900 hover:text-emerald-600 dark:text-gray-100 dark:hover:text-emerald-400"
                        >
                          {a.agentName ?? a.agentId}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant(a.status)}>
                          <AttemptStatusIcon status={a.status} />
                          {a.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {a.versionBefore ?? "?"} → {a.versionAfter ?? "?"}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                        {formatDate(a.startedAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                        {durationSecs(a.startedAt, a.completedAt)}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {a.error ? (
                          <span
                            className="text-rose-600 dark:text-rose-400"
                            title={a.error}
                          >
                            {a.error.length > 80 ? `${a.error.slice(0, 80)}…` : a.error}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  );
}

function AttemptStatusIcon({ status }: { status: string }): React.ReactElement | null {
  const className = cn("h-3 w-3");
  if (status === "success") return <CheckCircle2 className={className} />;
  if (status === "failed") return <XCircle className={className} />;
  if (status === "in_progress") return <Clock className={className} />;
  if (status === "skipped" || status === "paused") return <Pause className={className} />;
  return null;
}
