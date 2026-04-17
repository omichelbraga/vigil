"use client";

import { useMemo, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Download, Activity, Bell, Filter, Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusLabel, statusColor } from "@/lib/status";
import { useSession } from "@/lib/auth-client";
import { useToast } from "@/components/ui/toast-provider";
import type { IncidentRow } from "@/app/api/incidents/route";

type StatusFilter = "all" | "firing" | "acknowledged" | "resolved";
type SeverityFilter = "all" | "warning" | "critical";

async function fetchIncidents(status: StatusFilter): Promise<IncidentRow[]> {
  const url = `/api/incidents?status=${status}&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load incidents (${res.status})`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as IncidentRow[]) : [];
}

async function postIncidentAction(
  id: string,
  action: "ack" | "resolve",
): Promise<void> {
  const res = await fetch(`/api/incidents/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }
}

export default function AlertsPage(): React.ReactElement {
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const canMutate = role === "admin" || role === "editor";

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("firing");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");

  const { data, isLoading } = useQuery<IncidentRow[]>({
    queryKey: ["/api/incidents", statusFilter],
    queryFn: () => fetchIncidents(statusFilter),
    refetchInterval: 30_000,
  });

  const ackMutation = useMutation({
    mutationFn: (id: string) => postIncidentAction(id, "ack"),
    onSuccess: () => {
      success("Incident acknowledged");
      qc.invalidateQueries({ queryKey: ["/api/incidents"] });
    },
    onError: (err: unknown) => {
      toastError("Failed to acknowledge", err instanceof Error ? err.message : undefined);
    },
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => postIncidentAction(id, "resolve"),
    onSuccess: () => {
      success("Incident resolved");
      qc.invalidateQueries({ queryKey: ["/api/incidents"] });
    },
    onError: (err: unknown) => {
      toastError("Failed to resolve", err instanceof Error ? err.message : undefined);
    },
  });

  const incidents: IncidentRow[] = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(
    () =>
      incidents.filter((i) => {
        if (severityFilter !== "all" && i.severity !== severityFilter) return false;
        return true;
      }),
    [incidents, severityFilter],
  );

  const exportCsv = (): void => {
    const headers = [
      "Title",
      "Check",
      "Agent",
      "Severity",
      "Status",
      "Fired At",
      "Resolved At",
    ];
    const rows = filtered.map((i) => [
      i.title,
      i.checkName ?? "",
      i.agentName ?? "",
      i.severity,
      i.status,
      i.firedAt,
      i.resolvedAt ?? "",
    ]);

    const csv = [
      headers.join(","),
      ...rows.map((r) =>
        r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vigil-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  function timeAgo(dateStr?: string | null): string {
    if (!dateStr) return "—";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Activity className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:flex-nowrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Alerts
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Incidents and alert history
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Filters:
          </span>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        >
          <option value="firing">Firing</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        >
          <option value="all">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
        </select>
      </div>

      {/* Incidents Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {filtered.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Incident
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Severity
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Fired
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Resolved
                  </th>
                  {canMutate && (
                    <th className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {filtered.map((i) => {
                  const canAck = i.status === "firing" && i.source === "incident";
                  const canResolve = i.status !== "resolved" && i.source === "incident";
                  const busy =
                    (ackMutation.isPending && ackMutation.variables === i.id) ||
                    (resolveMutation.isPending && resolveMutation.variables === i.id);
                  return (
                    <tr
                      key={i.id}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                        {i.title}
                        {i.checkName && (
                          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                            {i.checkName}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {i.agentName ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                            statusColor(i.severity),
                          )}
                        >
                          {statusLabel(i.severity)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                            i.status === "firing"
                              ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400"
                              : i.status === "acknowledged"
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
                          )}
                        >
                          {i.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        <span title={i.firedAt}>{timeAgo(i.firedAt)}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        <span title={i.resolvedAt ?? undefined}>
                          {timeAgo(i.resolvedAt)}
                        </span>
                      </td>
                      {canMutate && (
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              onClick={() => ackMutation.mutate(i.id)}
                              disabled={!canAck || busy}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                              title={
                                i.source !== "incident"
                                  ? "Legacy alert — cannot be acknowledged"
                                  : "Acknowledge"
                              }
                            >
                              <Check className="h-3.5 w-3.5" />
                              Ack
                            </button>
                            <button
                              onClick={() => resolveMutation.mutate(i.id)}
                              disabled={!canResolve || busy}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400 dark:hover:bg-emerald-950/60"
                              title={
                                i.source !== "incident"
                                  ? "Legacy alert — cannot be resolved"
                                  : "Resolve"
                              }
                            >
                              <CheckCheck className="h-3.5 w-3.5" />
                              Resolve
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-12 text-center">
            <Bell className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
            <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-white">
              No incidents
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {statusFilter === "firing"
                ? "All systems are normal. Incidents will appear here when a check goes critical or warning."
                : "No incidents match the current filters."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
