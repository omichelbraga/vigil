"use client";

import { MoreHorizontal, VolumeX, Volume2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/overview/sparkline";
import { TypeIcon } from "./type-icon";
import { cn } from "@/lib/utils";
import type { MonitorStatus, MonitorSummary } from "@/lib/monitors";
import { monitorTypeLabel } from "@/lib/monitors";

interface MonitorsTableProps {
  items: MonitorSummary[];
  isLoading: boolean;
  onRowClick: (m: MonitorSummary) => void;
  onSilence?: (m: MonitorSummary) => void;
  onUnsilence?: (m: MonitorSummary) => void;
  onDelete?: (m: MonitorSummary) => void;
  isAdmin: boolean;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusBadge(s: MonitorStatus): React.ReactElement {
  if (s === "ok") return <Badge variant="ok">OK</Badge>;
  if (s === "warning") return <Badge variant="warn">Warning</Badge>;
  if (s === "critical") return <Badge variant="crit">Critical</Badge>;
  if (s === "silenced") return <Badge variant="info">Silenced</Badge>;
  return <Badge variant="muted">Unknown</Badge>;
}

export function MonitorsTable({
  items,
  isLoading,
  onRowClick,
  onSilence,
  onUnsilence,
  onDelete,
  isAdmin,
}: MonitorsTableProps): React.ReactElement {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
        Loading monitors…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center dark:border-gray-800 dark:bg-gray-900">
        <p className="text-sm text-gray-500 dark:text-gray-400">No monitors match these filters.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-950/40 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Name</th>
              <th className="px-3 py-2 text-left font-semibold">Type</th>
              <th className="px-3 py-2 text-left font-semibold">Target</th>
              <th className="px-3 py-2 text-left font-semibold">Interval</th>
              <th className="px-3 py-2 text-left font-semibold">Status</th>
              <th className="px-3 py-2 text-left font-semibold">Latency</th>
              <th className="px-3 py-2 text-left font-semibold">SLO</th>
              <th className="px-3 py-2 text-left font-semibold">Last result</th>
              <th className="px-3 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr
                key={`${m.kind}:${m.id}`}
                onClick={() => onRowClick(m)}
                className={cn(
                  "cursor-pointer border-t border-gray-100 transition-colors hover:bg-gray-50/60",
                  "dark:border-gray-800 dark:hover:bg-gray-800/40",
                )}
              >
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-900 dark:text-white">{m.name}</div>
                  {m.agentName ? (
                    <div className="text-xs text-gray-500 dark:text-gray-400">{m.agentName}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                    <TypeIcon type={m.type} />
                    <span>{monitorTypeLabel(m.type)}</span>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="truncate text-gray-700 dark:text-gray-200">{m.target}</span>
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                  {m.intervalSecs != null ? `${m.intervalSecs}s` : "—"}
                </td>
                <td className="px-3 py-2">{statusBadge(m.status)}</td>
                <td className="px-3 py-2">
                  <div className="w-20">
                    {m.latencySparkline.some((v) => v > 0) ? (
                      <Sparkline data={m.latencySparkline} height={20} />
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                  {m.slo != null ? `${m.slo}%` : "—"}
                </td>
                <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                  <div className="flex items-center gap-1.5">
                    {timeAgo(m.lastResultAt)}
                    {m.isStale && (
                      <span
                        title={`Last result is older than 3× interval (${m.intervalSecs ?? "?"}s). Agent may have stopped reporting this check.`}
                        className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                      >
                        Stale
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div
                    className="flex items-center justify-end gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isAdmin && m.kind === "check" ? (
                      m.status === "silenced" ? (
                        <button
                          type="button"
                          onClick={() => onUnsilence?.(m)}
                          title="Unmute"
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-emerald-600 dark:hover:bg-gray-700"
                        >
                          <Volume2 className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSilence?.(m)}
                          title="Silence 1h"
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-amber-600 dark:hover:bg-gray-700"
                        >
                          <VolumeX className="h-4 w-4" />
                        </button>
                      )
                    ) : null}
                    {isAdmin ? (
                      <button
                        type="button"
                        onClick={() => onDelete?.(m)}
                        title="Delete"
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onRowClick(m)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
