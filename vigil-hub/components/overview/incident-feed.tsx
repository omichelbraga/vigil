"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useSse } from "@/hooks/use-sse";
import { Activity, PartyPopper } from "lucide-react";
import type { IncidentRow } from "@/app/api/incidents/route";

interface IncidentFeedProps {
  limit?: number;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function SeverityDot({ severity }: { severity: IncidentRow["severity"] }): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full",
        severity === "critical" ? "bg-rose-500" : "bg-amber-500",
      )}
    />
  );
}

function StatusBadge({ status }: { status: IncidentRow["status"] }): React.ReactElement {
  if (status === "firing") return <Badge variant="crit">firing</Badge>;
  if (status === "acknowledged") return <Badge variant="warn">ack</Badge>;
  return <Badge variant="ok">resolved</Badge>;
}

type SseEventPayload = Record<string, unknown>;
function isIncidentEvent(data: unknown): data is SseEventPayload {
  return typeof data === "object" && data !== null;
}

export function IncidentFeed({ limit = 10 }: IncidentFeedProps): React.ReactElement {
  const [liveEvents, setLiveEvents] = useState<IncidentRow[]>([]);

  const { data, isLoading } = useQuery<IncidentRow[]>({
    queryKey: [`/api/incidents?status=firing&limit=${limit}`],
    queryFn: async () => {
      const res = await fetch(`/api/incidents?status=firing&limit=${limit}`);
      if (!res.ok) throw new Error("failed to load incidents");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const handleSse = useCallback(
    (eventName: string, raw: unknown) => {
      if (!eventName.startsWith("incident_") || !isIncidentEvent(raw)) return;
      // Shape-guard + coerce into IncidentRow
      const r = raw as {
        id?: unknown;
        agentId?: unknown;
        agentName?: unknown;
        checkId?: unknown;
        checkName?: unknown;
        severity?: unknown;
        status?: unknown;
        title?: unknown;
        firedAt?: unknown;
        resolvedAt?: unknown;
      };
      const id = typeof r.id === "string" ? r.id : null;
      if (!id) return;
      const row: IncidentRow = {
        id,
        source: "incident",
        agentId: typeof r.agentId === "string" ? r.agentId : null,
        agentName: typeof r.agentName === "string" ? r.agentName : null,
        checkId: typeof r.checkId === "string" ? r.checkId : null,
        checkName: typeof r.checkName === "string" ? r.checkName : null,
        severity: r.severity === "critical" ? "critical" : "warning",
        status:
          r.status === "acknowledged" || r.status === "resolved" ? r.status : "firing",
        title: typeof r.title === "string" ? r.title : "Incident",
        firedAt: typeof r.firedAt === "string" ? r.firedAt : new Date().toISOString(),
        resolvedAt: typeof r.resolvedAt === "string" ? r.resolvedAt : null,
      };
      setLiveEvents((prev) => {
        const filtered = prev.filter((p) => p.id !== row.id);
        return [row, ...filtered].slice(0, limit);
      });
    },
    [limit],
  );

  useSse({
    events: ["incident_fired", "incident_acknowledged", "incident_resolved"],
    onEvent: handleSse,
  });

  const merged = useMemo(() => {
    if (!data) return liveEvents;
    const byId = new Map<string, IncidentRow>();
    for (const row of [...liveEvents, ...data]) byId.set(row.id, row);
    return Array.from(byId.values())
      .sort((a, b) => new Date(b.firedAt).getTime() - new Date(a.firedAt).getTime())
      .slice(0, limit);
  }, [data, liveEvents, limit]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-500" />
            Incident feed
          </CardTitle>
          <CardDescription>Live — updates as alerts fire and resolve</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : merged.length === 0 ? (
          <EmptyState
            icon={PartyPopper}
            title="No incidents yet"
            description="Nothing's firing. When something breaks, it'll show up here in real time."
          />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {merged.map((row) => (
              <li key={row.id} className="flex items-start gap-3 py-2.5">
                <SeverityDot severity={row.severity} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {row.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {row.agentName ? <span className="truncate">{row.agentName}</span> : null}
                    {row.checkName ? <span className="truncate">· {row.checkName}</span> : null}
                    <span>· {timeAgo(row.firedAt)} ago</span>
                  </div>
                </div>
                <StatusBadge status={row.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
