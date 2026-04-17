"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Rocket,
  Pause,
  Play,
  XCircle,
  Eye,
  Plus,
  AlertTriangle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

interface RolloutListRow {
  id: string;
  status: string;
  release: {
    id: string;
    os: string;
    arch: string;
    version: string;
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
}

interface RolloutListResponse {
  items: RolloutListRow[];
  total: number;
  page: number;
  perPage: number;
}

interface ReleaseRow {
  id: string;
  os: string;
  arch: string;
  version: string;
  isActive: boolean;
  signature: string | null;
  sha256: string;
}

interface AgentRow {
  id: string;
  name: string;
  os: string | null;
  version: string | null;
  status: string;
  tags: string[];
}

function statusVariant(s: string): "ok" | "warn" | "crit" | "info" | "muted" {
  if (s === "running") return "info";
  if (s === "completed") return "ok";
  if (s === "failed") return "crit";
  if (s === "paused") return "warn";
  return "muted";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.floor(Math.abs(ms) / 1000);
  const future = ms < 0;
  const fmt = (n: number, u: string): string => (future ? `in ${n}${u}` : `${n}${u} ago`);
  if (sec < 60) return fmt(sec, "s");
  const min = Math.floor(sec / 60);
  if (min < 60) return fmt(min, "m");
  const hr = Math.floor(min / 60);
  if (hr < 24) return fmt(hr, "h");
  return fmt(Math.floor(hr / 24), "d");
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : null) || `Request failed: ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export default function AdminRolloutsPage(): React.ReactElement {
  const { data: session, isPending } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);

  const rolloutsQuery = useQuery<RolloutListResponse>({
    queryKey: ["admin", "rollouts"],
    queryFn: () => apiJson<RolloutListResponse>("/api/admin/rollouts?perPage=50"),
    enabled: role === "admin",
    refetchInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? false
        : 10_000,
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) =>
      apiJson<{ id: string; status: string }>(
        `/api/admin/rollouts/${id}/pause`,
        { method: "POST" },
      ),
    onSuccess: () => {
      toast.success("Rollout paused");
      qc.invalidateQueries({ queryKey: ["admin", "rollouts"] });
    },
    onError: (err) =>
      toast.error("Pause failed", err instanceof Error ? err.message : String(err)),
  });

  const resumeMutation = useMutation({
    mutationFn: (id: string) =>
      apiJson<{ id: string; status: string }>(
        `/api/admin/rollouts/${id}/resume`,
        { method: "POST" },
      ),
    onSuccess: () => {
      toast.success("Rollout resumed");
      qc.invalidateQueries({ queryKey: ["admin", "rollouts"] });
    },
    onError: (err) =>
      toast.error("Resume failed", err instanceof Error ? err.message : String(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      apiJson<{ id: string; status: string }>(
        `/api/admin/rollouts/${id}/cancel`,
        { method: "POST" },
      ),
    onSuccess: () => {
      toast.success("Rollout cancelled");
      qc.invalidateQueries({ queryKey: ["admin", "rollouts"] });
    },
    onError: (err) =>
      toast.error("Cancel failed", err instanceof Error ? err.message : String(err)),
  });

  const handleCancel = async (row: RolloutListRow): Promise<void> => {
    const ok = await confirm({
      title: "Cancel rollout",
      message: `Stop rollout for ${row.release.os}/${row.release.arch} v${row.release.version}? Pending agents will be marked skipped; in-flight updates cannot be recalled.`,
      confirmLabel: "Cancel rollout",
      variant: "danger",
    });
    if (!ok) return;
    cancelMutation.mutate(row.id);
  };

  if (isPending) return <Skeleton className="h-10 w-40" />;
  if (role !== "admin") {
    return (
      <EmptyState
        title="Admin only"
        description="You need the admin role to view fleet rollouts."
      />
    );
  }

  const items = rolloutsQuery.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Fleet rollouts
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Staged agent update jobs. Pause/resume/cancel at any time. Runner
            ticks every 30s and respects `autoUpdate` on each agent.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New rollout
        </Button>
      </div>

      {rolloutsQuery.error ? (
        <Card>
          <CardContent className="p-6 text-sm text-rose-600 dark:text-rose-400">
            {rolloutsQuery.error instanceof Error
              ? rolloutsQuery.error.message
              : "Failed to load rollouts."}
          </CardContent>
        </Card>
      ) : null}

      {rolloutsQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No rollouts yet"
          description="Create one to push a staged update to your agent fleet."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-3">Release</th>
                    <th className="px-4 py-3">Targets</th>
                    <th className="px-4 py-3">Progress</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {items.map((row) => (
                    <RolloutRow
                      key={row.id}
                      row={row}
                      onPause={() => pauseMutation.mutate(row.id)}
                      onResume={() => resumeMutation.mutate(row.id)}
                      onCancel={() => handleCancel(row)}
                      busy={
                        pauseMutation.isPending ||
                        resumeMutation.isPending ||
                        cancelMutation.isPending
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <NewRolloutDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={() => {
          setDialogOpen(false);
          qc.invalidateQueries({ queryKey: ["admin", "rollouts"] });
          toast.success("Rollout created");
        }}
      />
    </div>
  );
}

function RolloutRow({
  row,
  onPause,
  onResume,
  onCancel,
  busy,
}: {
  row: RolloutListRow;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  busy: boolean;
}): React.ReactElement {
  const processed = row.successCount + row.failureCount;
  const pct =
    row.targetsTotal > 0 ? Math.min(100, (processed / row.targetsTotal) * 100) : 0;

  const filterSummary = (() => {
    const f = row.targetFilter ?? {};
    const parts: string[] = [];
    if (f.os) parts.push(`os=${f.os}`);
    if (f.arch) parts.push(`arch=${f.arch}`);
    if (f.tags && f.tags.length > 0) parts.push(`tags:[${f.tags.join(",")}]`);
    if (f.agentIds && f.agentIds.length > 0)
      parts.push(`agents×${f.agentIds.length}`);
    return parts.length > 0 ? parts.join(" · ") : "all agents";
  })();

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-mono text-xs text-gray-900 dark:text-gray-100">
          {row.release.os}/{row.release.arch}
        </div>
        <div className="font-semibold text-gray-800 dark:text-gray-200">
          v{row.release.version}
        </div>
      </td>
      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
        <div className="text-xs font-mono">{filterSummary}</div>
        <div className="mt-0.5 text-xs text-gray-500">
          {row.targetsTotal} total · batch {row.batchSize} · delay {row.batchDelaySecs}s
          {row.canaryAgentId ? " · canary" : ""}
        </div>
      </td>
      <td className="px-4 py-3 w-64">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
          <div
            className="absolute inset-y-0 left-0 bg-emerald-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
          <span className="tabular-nums">{row.successCount} ok</span>
          <span>·</span>
          <span
            className={cn(
              "tabular-nums",
              row.failureCount > 0 && "text-rose-600 dark:text-rose-400",
            )}
          >
            {row.failureCount} fail
          </span>
          <span>·</span>
          <span className="tabular-nums">{row.targetsTotal} total</span>
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
      </td>
      <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
        <div>{relativeTime(row.createdAt)}</div>
        <div className="text-gray-500">{row.createdByEmail ?? "system"}</div>
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1.5">
          <Link href={`/admin/rollouts/${row.id}`} aria-label="View rollout">
            <Button size="sm" variant="outline" type="button">
              <Eye className="h-3.5 w-3.5" />
              View
            </Button>
          </Link>
          {row.status === "running" ? (
            <Button size="sm" variant="outline" type="button" disabled={busy} onClick={onPause}>
              <Pause className="h-3.5 w-3.5" />
              Pause
            </Button>
          ) : null}
          {row.status === "paused" || row.status === "queued" ? (
            <Button size="sm" variant="outline" type="button" disabled={busy} onClick={onResume}>
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
          ) : null}
          {row.status !== "completed" && row.status !== "failed" ? (
            <Button size="sm" variant="outline" type="button" disabled={busy} onClick={onCancel}>
              <XCircle className="h-3.5 w-3.5" />
              Cancel
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

interface NewRolloutDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function NewRolloutDialog({ open, onClose, onCreated }: NewRolloutDialogProps): React.ReactElement {
  const toast = useToast();

  const releasesQuery = useQuery<{ releases: ReleaseRow[] }>({
    queryKey: ["admin", "agent-releases", "for-rollout"],
    queryFn: () => apiJson<{ releases: ReleaseRow[] }>("/api/admin/agent-releases"),
    enabled: open,
  });
  const agentsQuery = useQuery<AgentRow[]>({
    queryKey: ["admin", "agents", "for-rollout"],
    queryFn: () => apiJson<AgentRow[]>("/api/agents"),
    enabled: open,
  });

  const [releaseId, setReleaseId] = useState<string>("");
  const [osFilter, setOsFilter] = useState<string>("");
  const [archFilter, setArchFilter] = useState<string>("");
  const [tagsFilter, setTagsFilter] = useState<string>("");
  const [agentIdsFilter, setAgentIdsFilter] = useState<string>("");
  const [batchSize, setBatchSize] = useState<number>(5);
  const [batchDelaySecs, setBatchDelaySecs] = useState<number>(600);
  const [canaryAgentId, setCanaryAgentId] = useState<string>("");

  const createMutation = useMutation({
    mutationFn: async (): Promise<{ id: string }> => {
      const targetFilter: Record<string, unknown> = {};
      if (osFilter) targetFilter.os = osFilter;
      if (archFilter) targetFilter.arch = archFilter;
      const tags = tagsFilter
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (tags.length > 0) targetFilter.tags = tags;
      const agentIds = agentIdsFilter
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      if (agentIds.length > 0) targetFilter.agentIds = agentIds;

      return apiJson<{ id: string }>("/api/admin/rollouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          releaseId,
          targetFilter,
          batchSize,
          batchDelaySecs,
          canaryAgentId: canaryAgentId || undefined,
        }),
      });
    },
    onSuccess: () => {
      onCreated();
      // Reset form
      setReleaseId("");
      setOsFilter("");
      setArchFilter("");
      setTagsFilter("");
      setAgentIdsFilter("");
      setBatchSize(5);
      setBatchDelaySecs(600);
      setCanaryAgentId("");
    },
    onError: (err) =>
      toast.error(
        "Create rollout failed",
        err instanceof Error ? err.message : String(err),
      ),
  });

  const activeSignedReleases = useMemo(
    () =>
      (releasesQuery.data?.releases ?? []).filter(
        (r) => r.isActive && r.signature && r.sha256,
      ),
    [releasesQuery.data],
  );

  const selectedRelease = activeSignedReleases.find((r) => r.id === releaseId);
  const selectedCanaryAgent = (agentsQuery.data ?? []).find((a) => a.id === canaryAgentId);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900">
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <Rocket className="h-4 w-4 text-emerald-500" />
            New rollout
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Push a signed agent binary to a subset of the fleet in controlled batches.
          </Dialog.Description>

          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!releaseId) {
                toast.error("Pick a release first");
                return;
              }
              createMutation.mutate();
            }}
          >
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                Release
              </label>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                value={releaseId}
                onChange={(e) => setReleaseId(e.target.value)}
                required
              >
                <option value="">-- select --</option>
                {activeSignedReleases.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.os}/{r.arch} v{r.version}
                  </option>
                ))}
              </select>
              {activeSignedReleases.length === 0 ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  No active, signed releases available.
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                  OS (optional)
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  placeholder={selectedRelease ? selectedRelease.os : "linux"}
                  value={osFilter}
                  onChange={(e) => setOsFilter(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                  Arch (optional)
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  placeholder={selectedRelease ? selectedRelease.arch : "amd64"}
                  value={archFilter}
                  onChange={(e) => setArchFilter(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                Tags (comma-separated, any match)
              </label>
              <input
                type="text"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                placeholder="prod, canary-wave1"
                value={tagsFilter}
                onChange={(e) => setTagsFilter(e.target.value)}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                Agent IDs (comma-separated, allowlist)
              </label>
              <input
                type="text"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                placeholder="optional"
                value={agentIdsFilter}
                onChange={(e) => setAgentIdsFilter(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                  Batch size
                </label>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value))}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                  Batch delay (sec)
                </label>
                <input
                  type="number"
                  min={0}
                  max={86_400}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  value={batchDelaySecs}
                  onChange={(e) => setBatchDelaySecs(Number(e.target.value))}
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                Canary agent (optional)
              </label>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                value={canaryAgentId}
                onChange={(e) => setCanaryAgentId(e.target.value)}
              >
                <option value="">none</option>
                {(agentsQuery.data ?? [])
                  .filter(
                    (a) =>
                      !selectedRelease ||
                      !a.os ||
                      a.os.toLowerCase() === selectedRelease.os.toLowerCase(),
                  )
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.status})
                    </option>
                  ))}
              </select>
              {selectedCanaryAgent && selectedCanaryAgent.status !== "online" ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  Canary is offline — update will queue until it reconnects.
                </p>
              ) : null}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating…" : "Create rollout"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
