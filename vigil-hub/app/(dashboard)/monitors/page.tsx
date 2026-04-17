"use client";

import { useMemo, useState } from "react";
import { Plus, Search, LayoutGrid, Table as TableIcon, Activity, FilterX } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MonitorsTable } from "@/components/monitors/monitors-table";
import { MonitorsGrid } from "@/components/monitors/monitors-grid";
import { MonitorDetailDrawer } from "@/components/monitors/monitor-detail-drawer";
import { CreateWizard } from "@/components/monitors/create-wizard";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  ALL_MONITOR_TYPES,
  monitorTypeLabel,
  type MonitorKind,
  type MonitorListResponse,
  type MonitorStatus,
  type MonitorSummary,
  type MonitorType,
} from "@/lib/monitors";

interface AgentOption {
  id: string;
  name: string;
}

const STATUS_FILTERS: { value: MonitorStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ok", label: "OK" },
  { value: "warning", label: "Warning" },
  { value: "critical", label: "Critical" },
  { value: "silenced", label: "Silenced" },
  { value: "unknown", label: "Unknown" },
];

type ViewMode = "table" | "grid";

export default function MonitorsPage(): React.ReactElement {
  const { data: session } = useSession();
  const isAdmin =
    (session?.user as { role?: string } | undefined)?.role === "admin";

  const [view, setView] = useState<ViewMode>("table");
  const [selectedTypes, setSelectedTypes] = useState<Set<MonitorType>>(new Set());
  const [status, setStatus] = useState<MonitorStatus | "all">("all");
  const [agentId, setAgentId] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [drawerTarget, setDrawerTarget] = useState<{ kind: MonitorKind; id: string } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const qc = useQueryClient();
  const { success, error: toastError } = useToast();
  const showConfirm = useConfirm();

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (selectedTypes.size > 0) p.set("type", [...selectedTypes].join(","));
    if (status !== "all") p.set("status", status);
    if (agentId) p.set("agent", agentId);
    if (search.trim()) p.set("search", search.trim());
    p.set("per_page", "200");
    return p.toString();
  }, [selectedTypes, status, agentId, search]);

  const monitorsQuery = useQuery<MonitorListResponse>({
    queryKey: ["monitors", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/monitors?${queryParams}`);
      if (!res.ok) throw new Error("Failed to load monitors");
      return (await res.json()) as MonitorListResponse;
    },
    refetchInterval: 30_000,
  });

  const agentsQuery = useQuery<AgentOption[]>({
    queryKey: ["monitors-agents"],
    queryFn: async () => {
      const res = await fetch("/api/agents");
      if (!res.ok) return [];
      const data = (await res.json()) as AgentOption[];
      return Array.isArray(data) ? data : [];
    },
  });

  const silenceMutation = useMutation({
    mutationFn: async (vars: { id: string; until: Date }) => {
      const res = await fetch(`/api/monitors/check/${vars.id}/silence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ until: vars.until.toISOString() }),
      });
      if (!res.ok) throw new Error("Silence failed");
      return res.json();
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["monitors"] });
      const previous = qc.getQueryData<MonitorListResponse>(["monitors", queryParams]);
      if (previous) {
        qc.setQueryData<MonitorListResponse>(["monitors", queryParams], {
          ...previous,
          items: previous.items.map((m) =>
            m.kind === "check" && m.id === vars.id
              ? { ...m, status: "silenced", silencedUntil: vars.until.toISOString() }
              : m,
          ),
        });
      }
      return { previous };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(["monitors", queryParams], ctx.previous);
      toastError("Failed to silence monitor");
    },
    onSuccess: () => success("Monitor silenced"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["monitors"] }),
  });

  const unsilenceMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/monitors/check/${id}/unsilence`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Unsilence failed");
      return res.json();
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["monitors"] });
      const previous = qc.getQueryData<MonitorListResponse>(["monitors", queryParams]);
      if (previous) {
        qc.setQueryData<MonitorListResponse>(["monitors", queryParams], {
          ...previous,
          items: previous.items.map((m) =>
            m.kind === "check" && m.id === id
              ? { ...m, silencedUntil: null, status: "unknown" }
              : m,
          ),
        });
      }
      return { previous };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(["monitors", queryParams], ctx.previous);
      toastError("Failed to unmute monitor");
    },
    onSuccess: () => success("Monitor unmuted"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["monitors"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (m: MonitorSummary) => {
      const path =
        m.kind === "check"
          ? `/api/checks/${m.id}`
          : m.kind === "cert"
            ? `/api/certs/${m.id}`
            : `/api/expiry-monitors/${m.id}`;
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      return res.json();
    },
    onMutate: async (m) => {
      await qc.cancelQueries({ queryKey: ["monitors"] });
      const previous = qc.getQueryData<MonitorListResponse>(["monitors", queryParams]);
      if (previous) {
        qc.setQueryData<MonitorListResponse>(["monitors", queryParams], {
          ...previous,
          items: previous.items.filter((i) => !(i.kind === m.kind && i.id === m.id)),
          total: previous.total - 1,
        });
      }
      return { previous };
    },
    onError: (_e, _m, ctx) => {
      if (ctx?.previous) qc.setQueryData(["monitors", queryParams], ctx.previous);
      toastError("Failed to delete monitor");
    },
    onSuccess: () => success("Monitor deleted"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["monitors"] }),
  });

  const items = monitorsQuery.data?.items ?? [];
  const isEmpty = !monitorsQuery.isLoading && items.length === 0 && !search && selectedTypes.size === 0 && status === "all" && !agentId;

  const toggleType = (t: MonitorType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const clearFilters = () => {
    setSelectedTypes(new Set());
    setStatus("all");
    setAgentId("");
    setSearch("");
  };

  const handleDelete = async (m: MonitorSummary) => {
    const ok = await showConfirm({
      title: "Delete monitor",
      message: `Delete "${m.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    deleteMutation.mutate(m);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Monitors</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Unified view of every health check, SSL certificate and expiry monitor.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
            <button
              type="button"
              onClick={() => setView("table")}
              aria-pressed={view === "table"}
              className={cn(
                "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                view === "table"
                  ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200",
              )}
            >
              <TableIcon className="h-3.5 w-3.5" /> Table
            </button>
            <button
              type="button"
              onClick={() => setView("grid")}
              aria-pressed={view === "grid"}
              className={cn(
                "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                view === "grid"
                  ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200",
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Grid
            </button>
          </div>

          {isAdmin ? (
            <Button onClick={() => setWizardOpen(true)}>
              <Plus /> Create Monitor
            </Button>
          ) : null}
        </div>
      </div>

      {/* Filter rail */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / target / agent"
            className="h-9 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as MonitorStatus | "all")}
          className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="">All agents</option>
          {(agentsQuery.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          {ALL_MONITOR_TYPES.map((t) => {
            const active = selectedTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                aria-pressed={active}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800",
                )}
              >
                {monitorTypeLabel(t)}
              </button>
            );
          })}
          {selectedTypes.size > 0 || status !== "all" || agentId || search ? (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-2 inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <FilterX className="h-3 w-3" /> Clear
            </button>
          ) : null}
        </div>
      </div>

      {/* Body */}
      {isEmpty ? (
        <EmptyState
          icon={Activity}
          title="No monitors yet"
          description="Create your first monitor to start tracking the health of a service, certificate or expiring credential."
          action={
            isAdmin ? (
              <Button onClick={() => setWizardOpen(true)}>
                <Plus /> Create your first monitor
              </Button>
            ) : undefined
          }
        />
      ) : view === "table" ? (
        <MonitorsTable
          items={items}
          isLoading={monitorsQuery.isLoading}
          isAdmin={isAdmin}
          onRowClick={(m) => setDrawerTarget({ kind: m.kind, id: m.id })}
          onSilence={(m) =>
            silenceMutation.mutate({ id: m.id, until: new Date(Date.now() + 60 * 60_000) })
          }
          onUnsilence={(m) => unsilenceMutation.mutate(m.id)}
          onDelete={handleDelete}
        />
      ) : (
        <MonitorsGrid
          items={items}
          isLoading={monitorsQuery.isLoading}
          onCardClick={(m) => setDrawerTarget({ kind: m.kind, id: m.id })}
        />
      )}

      {/* Detail drawer */}
      <MonitorDetailDrawer
        open={!!drawerTarget}
        onClose={() => setDrawerTarget(null)}
        target={drawerTarget}
        isAdmin={isAdmin}
      />

      {/* Create wizard */}
      <CreateWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  );
}
