"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileJson,
  Filter,
  X,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

interface AuditActor {
  id: string;
  email: string;
  name: string | null;
}

interface AuditItem {
  id: string;
  createdAt: string;
  action: string;
  resource: string;
  actor: AuditActor | null;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
}

interface AuditResponse {
  items: AuditItem[];
  total: number;
  page: number;
  perPage: number;
}

interface Filters {
  actorId: string;
  action: string;
  entityType: string;
  from: string;
  to: string;
  showSystem: boolean;
  page: number;
  perPage: number;
}

const DEFAULT_FILTERS: Filters = {
  actorId: "",
  action: "",
  entityType: "",
  from: "",
  to: "",
  showSystem: false,
  page: 1,
  perPage: 50,
};

const ENTITY_OPTIONS = [
  { value: "", label: "All entity types" },
  { value: "agent", label: "Agent" },
  { value: "check", label: "Check" },
  { value: "cert", label: "Certificate" },
  { value: "expiry", label: "Expiry monitor" },
  { value: "user", label: "User" },
  { value: "settings", label: "Settings" },
  { value: "azure_kv", label: "Azure Key Vault" },
  { value: "enrollment_token", label: "Enrollment token" },
  { value: "setup", label: "Setup" },
];

function toSearchParams(f: Filters): string {
  const p = new URLSearchParams();
  if (f.actorId) p.set("actorId", f.actorId);
  if (f.action) p.set("action", f.action);
  if (f.entityType) p.set("entityType", f.entityType);
  if (f.from) p.set("from", new Date(f.from).toISOString());
  if (f.to) p.set("to", new Date(f.to).toISOString());
  if (f.showSystem) p.set("showSystem", "1");
  p.set("page", String(f.page));
  p.set("per_page", String(f.perPage));
  return p.toString();
}

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr}y ago`;
}

function verbFromAction(action: string): string {
  const dot = action.indexOf(".");
  return dot > 0 ? action.slice(0, dot) : action;
}

function badgeVariant(
  action: string,
): "ok" | "warn" | "crit" | "info" | "muted" {
  const verb = verbFromAction(action);
  switch (verb) {
    case "create":
    case "invite":
    case "approve":
    case "enroll":
      return "ok";
    case "update":
      return "info";
    case "delete":
    case "reject":
      return "crit";
    case "enrollment":
    case "setup":
    case "settings":
      return "warn";
    default:
      return "muted";
  }
}

function tailOf(id: string | null): string {
  if (!id) return "—";
  return id.length > 8 ? `…${id.slice(-8)}` : id;
}

export default function AdminAuditPage(): React.ReactElement {
  const { data: session, isPending } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<AuditItem | null>(null);

  const qs = useMemo(() => toSearchParams(filters), [filters]);

  const { data, isFetching, isLoading, error } = useQuery<AuditResponse>({
    queryKey: ["admin-audit", qs],
    queryFn: async () => {
      const res = await fetch(`/api/admin/audit?${qs}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Request failed (${res.status})`,
        );
      }
      return (await res.json()) as AuditResponse;
    },
    enabled: role === "admin",
    placeholderData: keepPreviousData,
  });

  if (isPending) {
    return <Skeleton className="h-10 w-40" />;
  }

  if (role !== "admin") {
    return (
      <EmptyState
        title="Admin only"
        description="You need the admin role to view the audit log."
      />
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / filters.perPage)) : 1;

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: key === "page" ? (value as number) : 1 }));
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Audit Log
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Immutable record of every mutating action across Vigil.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/admin/audit/export?${qs}&format=csv`}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </a>
          <a
            href={`/api/admin/audit/export?${qs}&format=json`}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
          >
            <FileJson className="h-4 w-4" />
            Export JSON
          </a>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setFilters(DEFAULT_FILTERS)}
          >
            Reset
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Actor ID
              </span>
              <input
                type="search"
                value={filters.actorId}
                onChange={(e) => setFilter("actorId", e.target.value)}
                placeholder="user id"
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Action (prefix)
              </span>
              <input
                type="search"
                value={filters.action}
                onChange={(e) => setFilter("action", e.target.value)}
                placeholder="e.g. check. or user.invite"
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Entity type
              </span>
              <select
                value={filters.entityType}
                onChange={(e) => setFilter("entityType", e.target.value)}
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              >
                {ENTITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                From
              </span>
              <input
                type="datetime-local"
                value={filters.from}
                onChange={(e) => setFilter("from", e.target.value)}
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                To
              </span>
              <input
                type="datetime-local"
                value={filters.to}
                onChange={(e) => setFilter("to", e.target.value)}
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
              <input
                type="checkbox"
                checked={filters.showSystem}
                onChange={(e) => setFilter("showSystem", e.target.checked)}
                className="accent-emerald-600"
              />
              Show system events (no actor)
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6 text-sm text-rose-600 dark:text-rose-400">
              {error instanceof Error ? error.message : "Failed to load audit log"}
            </div>
          ) : isLoading ? (
            <div className="flex flex-col gap-2 p-5">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <EmptyState
              title="No audit events"
              description="No events match the current filters."
              className="border-0 p-10"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-950/40">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      When
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Actor
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Action
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Entity
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      IP
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      UA
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setSelected(row)}
                      className={cn(
                        "cursor-pointer border-t border-gray-100 transition-colors hover:bg-gray-50/70",
                        "dark:border-gray-800 dark:hover:bg-gray-800/40",
                      )}
                    >
                      <td
                        className="whitespace-nowrap px-4 py-2.5 text-gray-700 dark:text-gray-200"
                        title={new Date(row.createdAt).toLocaleString()}
                      >
                        {relativeTime(row.createdAt)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700 dark:text-gray-200">
                        {row.actor ? (
                          <span>{row.actor.email}</span>
                        ) : (
                          <span className="text-gray-400 italic">system</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={badgeVariant(row.action)}>
                          {row.action}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-700 dark:text-gray-200">
                        <span className="font-medium">{row.entityType ?? "—"}</span>
                        <span className="ml-1 text-xs text-gray-400">
                          {tailOf(row.entityId)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-gray-600 dark:text-gray-300">
                        {row.ipAddress ?? "—"}
                      </td>
                      <td
                        className="max-w-xs truncate px-4 py-2.5 text-xs text-gray-500"
                        title={row.userAgent ?? undefined}
                      >
                        {row.userAgent ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {data ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-2.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
              <div className="flex items-center gap-2">
                <span>Rows per page</span>
                <select
                  value={filters.perPage}
                  onChange={(e) => setFilter("perPage", Number(e.target.value))}
                  className="h-8 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                >
                  {[25, 50, 100, 200].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {isFetching ? (
                  <span className="ml-2 text-gray-400">Updating…</span>
                ) : null}
              </div>

              <div className="flex items-center gap-3">
                <span>
                  Page {data.page} of {totalPages} · {data.total} total
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setFilter("page", Math.max(1, filters.page - 1))}
                    disabled={filters.page <= 1}
                    aria-label="Previous page"
                    className="h-7 w-7"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      setFilter(
                        "page",
                        Math.min(totalPages, filters.page + 1),
                      )
                    }
                    disabled={filters.page >= totalPages}
                    aria-label="Next page"
                    className="h-7 w-7"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Drawer — full JSON view */}
      {selected ? (
        <div
          className="fixed inset-0 z-50 flex"
          role="dialog"
          aria-modal="true"
          aria-labelledby="audit-drawer-title"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSelected(null)}
          />
          <aside className="relative ml-auto flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-950">
            <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
              <div>
                <h2
                  id="audit-drawer-title"
                  className="text-lg font-semibold text-gray-900 dark:text-white"
                >
                  {selected.action}
                </h2>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {new Date(selected.createdAt).toLocaleString()} ·{" "}
                  {relativeTime(selected.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </header>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
              <DrawerRow label="Actor">
                {selected.actor ? (
                  <div>
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {selected.actor.email}
                    </div>
                    <div className="font-mono text-xs text-gray-500">
                      {selected.actor.id}
                    </div>
                  </div>
                ) : (
                  <span className="italic text-gray-500">system</span>
                )}
              </DrawerRow>
              <DrawerRow label="Entity">
                <div>
                  <div>{selected.entityType ?? "—"}</div>
                  <div className="font-mono text-xs text-gray-500">
                    {selected.entityId ?? "—"}
                  </div>
                </div>
              </DrawerRow>
              <DrawerRow label="IP address">
                <span className="font-mono text-xs">
                  {selected.ipAddress ?? "—"}
                </span>
              </DrawerRow>
              <DrawerRow label="User agent">
                <span className="break-all text-xs text-gray-600 dark:text-gray-300">
                  {selected.userAgent ?? "—"}
                </span>
              </DrawerRow>
              <DrawerRow label="Metadata">
                <pre className="max-h-96 overflow-auto rounded-lg bg-gray-950 p-3 text-xs text-emerald-300">
                  {JSON.stringify(selected.metadata ?? {}, null, 2)}
                </pre>
              </DrawerRow>
            </div>
            <footer className="border-t border-gray-200 px-5 py-3 text-right dark:border-gray-800">
              <Link
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setSelected(null);
                }}
                className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Close
              </Link>
            </footer>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

interface DrawerRowProps {
  label: string;
  children: React.ReactNode;
}

function DrawerRow({ label, children }: DrawerRowProps): React.ReactElement {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="text-sm text-gray-800 dark:text-gray-100">{children}</div>
    </div>
  );
}
