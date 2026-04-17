"use client";

import { useMemo } from "react";

import * as Dialog from "@radix-ui/react-dialog";
import { X, Trash2, Play } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TypeIcon } from "./type-icon";
import { SilencePicker } from "./silence-picker";
import { LatencyHistogram } from "./latency-histogram";
import { StatusTimelineChart } from "./status-timeline-chart";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { monitorTypeLabel, type MonitorKind, type MonitorType } from "@/lib/monitors";

interface DetailAgent {
  id: string;
  name: string;
}

interface DetailResult {
  id?: string;
  status: string;
  message?: string | null;
  responseTimeMs?: number | null;
  timestamp: string;
}

interface MonitorDetail {
  kind: MonitorKind;
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  intervalSecs: number | null;
  slo: number | null;
  runbookMarkdown: string | null;
  silencedUntil: string | null;
  agent: DetailAgent | null;
  recentResults: DetailResult[];
  histogram: { responseTimeMs: number; status: string; timestamp: string }[];
  expiresAt?: string | null;
  issuer?: string | null;
  status?: string | null;
  category?: string | null;
  description?: string | null;
  lastChecked?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MonitorDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  target: { kind: MonitorKind; id: string } | null;
  isAdmin: boolean;
}

function formatDate(d?: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function statusBadge(status: string | null | undefined): React.ReactElement {
  const s = (status ?? "unknown").toLowerCase();
  if (s === "ok" || s === "valid") return <Badge variant="ok">OK</Badge>;
  if (s === "warning" || s === "warn" || s === "expiring")
    return <Badge variant="warn">Warning</Badge>;
  if (s === "critical" || s === "offline" || s === "expired")
    return <Badge variant="crit">Critical</Badge>;
  if (s === "silenced") return <Badge variant="info">Silenced</Badge>;
  return <Badge variant="muted">Unknown</Badge>;
}

/** Lightweight Markdown fallback renderer — preserves newlines + basic emphasis. */
function SimpleMarkdown({ text }: { text: string }): React.ReactElement {
  const html = useMemo(() => {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escaped
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code class=\"rounded bg-gray-100 px-1 dark:bg-gray-800\">$1</code>")
      .replace(/\n/g, "<br/>");
  }, [text]);
  return (
    <div
      className="text-sm text-gray-700 dark:text-gray-200"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function MonitorDetailDrawer({
  open,
  onClose,
  target,
  isAdmin,
}: MonitorDetailDrawerProps): React.ReactElement | null {
  const { success, error: toastError } = useToast();
  const showConfirm = useConfirm();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<MonitorDetail>({
    queryKey: ["monitor-detail", target?.kind, target?.id],
    enabled: open && !!target,
    queryFn: async () => {
      if (!target) throw new Error("no target");
      const res = await fetch(`/api/monitors/${target.kind}/${target.id}`);
      if (!res.ok) throw new Error("Failed to load");
      return (await res.json()) as MonitorDetail;
    },
  });

  const silenceMutation = useMutation({
    mutationFn: async (until: Date) => {
      if (!target || target.kind !== "check") throw new Error("silence only for checks");
      const res = await fetch(`/api/monitors/check/${target.id}/silence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ until: until.toISOString() }),
      });
      if (!res.ok) throw new Error("Silence failed");
      return res.json();
    },
    onSuccess: () => {
      success("Monitor silenced");
      qc.invalidateQueries({ queryKey: ["monitor-detail"] });
      qc.invalidateQueries({ queryKey: ["monitors"] });
    },
    onError: () => toastError("Failed to silence monitor"),
  });

  const unsilenceMutation = useMutation({
    mutationFn: async () => {
      if (!target || target.kind !== "check") throw new Error("unsilence only for checks");
      const res = await fetch(`/api/monitors/check/${target.id}/unsilence`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Unsilence failed");
      return res.json();
    },
    onSuccess: () => {
      success("Monitor unmuted");
      qc.invalidateQueries({ queryKey: ["monitor-detail"] });
      qc.invalidateQueries({ queryKey: ["monitors"] });
    },
    onError: () => toastError("Failed to unmute monitor"),
  });

  const runNowMutation = useMutation({
    mutationFn: async () => {
      if (!target || target.kind !== "check") throw new Error("run-now only for checks");
      const res = await fetch(`/api/monitors/check/${target.id}/run-now`, {
        method: "POST",
      });
      if (!res.ok) {
        if (res.status === 503) throw new Error("Agent offline");
        throw new Error("Run-now failed");
      }
      return res.json();
    },
    onSuccess: () => {
      success("Run-now queued — agent will execute this check");
      qc.invalidateQueries({ queryKey: ["monitor-detail"] });
    },
    onError: (err: Error) =>
      toastError(err.message === "Agent offline" ? "Agent is offline" : "Failed to run check"),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("no target");
      const path =
        target.kind === "check"
          ? `/api/checks/${target.id}`
          : target.kind === "cert"
            ? `/api/certs/${target.id}`
            : `/api/expiry-monitors/${target.id}`;
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      return res.json();
    },
    onSuccess: () => {
      success("Monitor deleted");
      qc.invalidateQueries({ queryKey: ["monitors"] });
      onClose();
    },
    onError: () => toastError("Failed to delete monitor"),
  });

  if (!target) return null;

  const histogramSamples =
    data?.histogram
      ?.filter((h) => h.responseTimeMs != null)
      .map((h) => ({ responseTimeMs: h.responseTimeMs })) ?? [];
  const timelineSamples =
    data?.recentResults?.map((r) => ({ timestamp: r.timestamp, status: r.status })) ?? [];

  const headerStatus: string =
    data?.status ?? data?.recentResults[0]?.status ?? "unknown";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col",
            "bg-white shadow-2xl dark:bg-gray-950",
            "data-[state=open]:animate-in data-[state=open]:slide-in-from-right",
            "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right",
          )}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-gray-200 p-5 dark:border-gray-800">
            <div className="min-w-0 flex-1">
              {isLoading || !data ? (
                <>
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="mt-2 h-4 w-1/3" />
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <TypeIcon type={data.type as MonitorType} />
                    <Dialog.Title className="truncate text-lg font-semibold text-gray-900 dark:text-white">
                      {data.name}
                    </Dialog.Title>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>{monitorTypeLabel(data.type as MonitorType)}</span>
                    {data.agent ? <span>· Agent: {data.agent.name}</span> : null}
                    {data.intervalSecs != null ? (
                      <span>· every {data.intervalSecs}s</span>
                    ) : null}
                    {data.slo != null ? <span>· SLO {data.slo}%</span> : null}
                    <span className="ml-auto">{statusBadge(headerStatus)}</span>
                  </div>
                </>
              )}
            </div>
            <Dialog.Close asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close"
                onClick={onClose}
                className="h-8 w-8"
              >
                <X />
              </Button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {isLoading || !data ? (
              <>
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </>
            ) : (
              <>
                {/* Timeline (checks only) */}
                {data.kind === "check" ? (
                  <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                    <StatusTimelineChart samples={timelineSamples} />
                  </div>
                ) : null}

                {/* Histogram (checks only, with samples) */}
                {data.kind === "check" ? (
                  <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Latency histogram (last 1000 samples)
                    </p>
                    <LatencyHistogram samples={histogramSamples} />
                  </div>
                ) : null}

                {/* Config (read-only) */}
                <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Config
                  </p>
                  <pre className="max-h-48 overflow-auto rounded-md bg-gray-50 p-3 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                    {JSON.stringify(data.config, null, 2)}
                  </pre>
                </div>

                {/* Silence picker (admin, checks only) */}
                {isAdmin && data.kind === "check" ? (
                  <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Silence
                    </p>
                    <SilencePicker
                      silencedUntil={data.silencedUntil}
                      onSilence={(until) => silenceMutation.mutateAsync(until)}
                      onUnsilence={() => unsilenceMutation.mutateAsync()}
                    />
                  </div>
                ) : null}

                {/* Runbook */}
                {data.runbookMarkdown ? (
                  <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Runbook
                    </p>
                    <SimpleMarkdown text={data.runbookMarkdown} />
                  </div>
                ) : null}

                {/* Cert / Expiry specific panel */}
                {data.kind === "cert" || data.kind === "expiry" ? (
                  <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Expiration
                    </p>
                    <dl className="grid grid-cols-2 gap-y-2 text-sm">
                      <dt className="text-gray-500">Expires at</dt>
                      <dd className="text-gray-900 dark:text-gray-100">
                        {formatDate(data.expiresAt)}
                      </dd>
                      <dt className="text-gray-500">Last checked</dt>
                      <dd className="text-gray-900 dark:text-gray-100">
                        {formatDate(data.lastChecked)}
                      </dd>
                      {data.issuer ? (
                        <>
                          <dt className="text-gray-500">Issuer</dt>
                          <dd className="truncate text-gray-900 dark:text-gray-100">{data.issuer}</dd>
                        </>
                      ) : null}
                      {data.category ? (
                        <>
                          <dt className="text-gray-500">Category</dt>
                          <dd className="text-gray-900 dark:text-gray-100">{data.category}</dd>
                        </>
                      ) : null}
                    </dl>
                  </div>
                ) : null}

                {/* Result log (checks only) */}
                {data.kind === "check" && data.recentResults.length > 0 ? (
                  <div className="rounded-xl border border-gray-200 dark:border-gray-800">
                    <p className="border-b border-gray-200 p-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
                      Recent results (last 50)
                    </p>
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">When</th>
                            <th className="px-3 py-2 text-left font-medium">Status</th>
                            <th className="px-3 py-2 text-left font-medium">Latency</th>
                            <th className="px-3 py-2 text-left font-medium">Message</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.recentResults.map((r, i) => (
                            <tr
                              key={r.id ?? i}
                              className="border-t border-gray-100 dark:border-gray-800"
                            >
                              <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">
                                {new Date(r.timestamp).toLocaleString()}
                              </td>
                              <td className="px-3 py-1.5">{statusBadge(r.status)}</td>
                              <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">
                                {r.responseTimeMs != null ? `${r.responseTimeMs}ms` : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">
                                {r.message ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* Footer actions */}
          {isAdmin ? (
            <div className="flex items-center justify-end gap-2 border-t border-gray-200 p-4 dark:border-gray-800">
              {data?.kind === "check" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => runNowMutation.mutate()}
                  disabled={runNowMutation.isPending}
                >
                  <Play />
                  {runNowMutation.isPending ? "Queuing..." : "Run now"}
                </Button>
              ) : null}
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  const ok = await showConfirm({
                    title: "Delete monitor",
                    message: `Delete "${data?.name ?? "this monitor"}"? This cannot be undone.`,
                    confirmLabel: "Delete",
                    variant: "danger",
                  });
                  if (ok) deleteMutation.mutate();
                }}
              >
                <Trash2 />
                Delete
              </Button>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
