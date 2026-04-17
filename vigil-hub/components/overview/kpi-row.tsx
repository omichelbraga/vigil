"use client";

import { useQuery } from "@tanstack/react-query";
import { KpiCard } from "./kpi-card";
import { Sparkline } from "./sparkline";
import { HealthBanner } from "./health-banner";

interface KpiPayload {
  agentsOnline: number;
  agentsTotal: number;
  agentsOnlineSparkline: number[];
  openIncidents: number;
  incidentsTrendHourly: number[];
  uptimePct7d: number;
  mttrSeconds7d: number;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

export function KpiRow(): React.ReactElement {
  const { data, isLoading, isError } = useQuery<KpiPayload>({
    queryKey: ["/api/overview/kpis"],
    queryFn: async () => {
      const res = await fetch("/api/overview/kpis");
      if (!res.ok) throw new Error("failed to load KPIs");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const agentsTone =
    !data || data.agentsTotal === 0
      ? "neutral"
      : data.agentsOnline === data.agentsTotal
        ? "ok"
        : data.agentsOnline === 0
          ? "crit"
          : "warn";

  const incidentsTone =
    !data || data.openIncidents === 0 ? "ok" : data.openIncidents > 3 ? "crit" : "warn";

  const uptimeTone = !data
    ? "neutral"
    : data.uptimePct7d >= 99.5
      ? "ok"
      : data.uptimePct7d >= 98
        ? "warn"
        : "crit";

  return (
    <>
      <HealthBanner openIncidents={data?.openIncidents ?? 0} />

      <div className="col-span-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Agents online"
          value={data ? `${data.agentsOnline} / ${data.agentsTotal}` : "—"}
          secondary="24h connected count"
          tone={agentsTone}
          loading={isLoading}
          chart={
            <Sparkline
              data={data?.agentsOnlineSparkline ?? []}
              variant="line"
              color="#10b981"
            />
          }
        />

        <KpiCard
          label="Open incidents"
          value={data ? String(data.openIncidents) : "—"}
          secondary="Fired in last 24h"
          tone={incidentsTone}
          loading={isLoading}
          chart={
            <Sparkline
              data={data?.incidentsTrendHourly ?? []}
              variant="bar"
              color={data && data.openIncidents > 0 ? "#f43f5e" : "#94a3b8"}
            />
          }
        />

        <KpiCard
          label="Uptime (7d)"
          value={data ? `${data.uptimePct7d.toFixed(2)}%` : "—"}
          secondary="Fleet avg across checks"
          tone={uptimeTone}
          loading={isLoading}
          chart={
            <Sparkline
              data={
                data
                  ? Array.from({ length: 12 }, () =>
                      Math.max(0, Math.min(100, data.uptimePct7d)),
                    )
                  : []
              }
              variant="line"
              color="#10b981"
            />
          }
        />

        <KpiCard
          label="MTTR (7d)"
          value={data ? formatDuration(data.mttrSeconds7d) : "—"}
          secondary="Avg time to resolve"
          tone="neutral"
          loading={isLoading}
          chart={
            <Sparkline
              data={data && data.mttrSeconds7d > 0 ? [data.mttrSeconds7d] : []}
              variant="bar"
              color="#6366f1"
            />
          }
        />
      </div>

      {isError && (
        <div className="col-span-12 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          Failed to load KPIs. Retrying…
        </div>
      )}
    </>
  );
}
