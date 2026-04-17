"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IncidentRow } from "@/app/api/incidents/route";

interface HealthBannerProps {
  openIncidents: number;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function HealthBanner({ openIncidents }: HealthBannerProps): React.ReactElement {
  const shouldFetchTop = openIncidents > 0;

  const { data: topIncidents, isLoading } = useQuery<IncidentRow[]>({
    queryKey: ["/api/incidents?status=firing&limit=1"],
    queryFn: async () => {
      const res = await fetch("/api/incidents?status=firing&limit=1");
      if (!res.ok) throw new Error("failed to load incidents");
      return res.json();
    },
    enabled: shouldFetchTop,
    refetchInterval: 30_000,
  });

  const healthy = openIncidents === 0;
  const top = topIncidents?.[0];
  const critical = top?.severity === "critical";

  const tone = healthy
    ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100"
    : critical
      ? "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
      : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100";

  return (
    <div
      className={cn(
        "col-span-12 flex items-center justify-between rounded-xl border px-5 py-3",
        tone,
      )}
    >
      <div className="flex items-center gap-3">
        {healthy ? (
          <CheckCircle2 className="h-5 w-5" />
        ) : (
          <AlertTriangle className="h-5 w-5" />
        )}
        <div>
          <div className="text-sm font-semibold">
            {healthy
              ? "All systems operational"
              : `${openIncidents} open incident${openIncidents === 1 ? "" : "s"}`}
          </div>
          {!healthy && (
            <div className="text-xs opacity-90">
              {isLoading ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> loading top incident…
                </span>
              ) : top ? (
                <>
                  <span className="font-medium">{top.title}</span>
                  {top.agentName ? <span> · {top.agentName}</span> : null}
                  <span> · {timeAgo(top.firedAt)}</span>
                </>
              ) : (
                "Something's firing — see the feed below."
              )}
            </div>
          )}
        </div>
      </div>
      {!healthy && top && (
        <a
          href="/alerts"
          className="rounded-md border border-current px-3 py-1 text-xs font-medium hover:bg-white/40 dark:hover:bg-white/10"
        >
          View alerts
        </a>
      )}
    </div>
  );
}
