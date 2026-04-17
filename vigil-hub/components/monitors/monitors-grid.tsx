"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/overview/sparkline";
import { TypeIcon } from "./type-icon";
import type { MonitorStatus, MonitorSummary } from "@/lib/monitors";
import { monitorTypeLabel } from "@/lib/monitors";
import { cn } from "@/lib/utils";

interface MonitorsGridProps {
  items: MonitorSummary[];
  isLoading: boolean;
  onCardClick: (m: MonitorSummary) => void;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusBadge(s: MonitorStatus): React.ReactElement {
  if (s === "ok") return <Badge variant="ok">OK</Badge>;
  if (s === "warning") return <Badge variant="warn">Warning</Badge>;
  if (s === "critical") return <Badge variant="crit">Critical</Badge>;
  if (s === "silenced") return <Badge variant="info">Silenced</Badge>;
  return <Badge variant="muted">Unknown</Badge>;
}

function statusRingClass(s: MonitorStatus): string {
  switch (s) {
    case "ok":
      return "ring-emerald-500/20";
    case "warning":
      return "ring-amber-500/30";
    case "critical":
      return "ring-rose-500/40";
    case "silenced":
      return "ring-sky-500/30";
    default:
      return "ring-slate-300/40";
  }
}

export function MonitorsGrid({
  items,
  isLoading,
  onCardClick,
}: MonitorsGridProps): React.ReactElement {
  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-36 animate-pulse" />
        ))}
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
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((m) => (
        <button
          key={`${m.kind}:${m.id}`}
          type="button"
          onClick={() => onCardClick(m)}
          className="block text-left"
        >
          <Card
            className={cn(
              "flex h-full flex-col gap-3 p-4 transition-all hover:shadow-md ring-1",
              statusRingClass(m.status),
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  <TypeIcon type={m.type} />
                  <span className="truncate">{m.name}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                  {monitorTypeLabel(m.type)} · {m.target}
                </div>
              </div>
              {statusBadge(m.status)}
            </div>

            <div className="flex items-end justify-between text-xs text-gray-500 dark:text-gray-400">
              <div>
                {m.agentName ? <div>{m.agentName}</div> : null}
                <div>
                  {m.intervalSecs != null ? `every ${m.intervalSecs}s · ` : ""}
                  {timeAgo(m.lastResultAt)}
                </div>
                {m.slo != null ? <div>SLO {m.slo}%</div> : null}
              </div>
              <div className="w-24">
                {m.latencySparkline.some((v) => v > 0) ? (
                  <Sparkline data={m.latencySparkline} height={28} />
                ) : null}
              </div>
            </div>
          </Card>
        </button>
      ))}
    </div>
  );
}
