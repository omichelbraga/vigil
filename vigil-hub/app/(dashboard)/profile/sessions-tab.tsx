"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Monitor, Trash2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { parseUserAgent } from "@/lib/user-agent";
import type { ProfileSession } from "./profile-types";

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function SessionsTab(): React.ReactElement {
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();
  const confirm = useConfirm();

  const sessions = useQuery({
    queryKey: ["profile", "sessions"],
    queryFn: async (): Promise<ProfileSession[]> => {
      const res = await fetch("/api/profile/sessions");
      if (!res.ok) throw new Error("Failed to load sessions");
      return (await res.json()) as ProfileSession[];
    },
  });

  const revokeOne = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/api/profile/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to revoke");
      }
    },
    onSuccess: () => {
      success("Session revoked");
      void qc.invalidateQueries({ queryKey: ["profile", "sessions"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed";
      toastError("Could not revoke", message);
    },
  });

  const revokeOthers = useMutation({
    mutationFn: async (): Promise<number> => {
      const res = await fetch("/api/profile/sessions?others=true", { method: "DELETE" });
      const data = (await res.json()) as { revoked?: number; error?: string };
      if (!res.ok) throw new Error(data.error || "Failed");
      return data.revoked ?? 0;
    },
    onSuccess: (count) => {
      success(`Revoked ${count} other session${count === 1 ? "" : "s"}`);
      void qc.invalidateQueries({ queryKey: ["profile", "sessions"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed";
      toastError("Could not revoke", message);
    },
  });

  const data = sessions.data ?? [];
  const othersCount = data.filter((s) => !s.isCurrent).length;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Active sessions
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Sign out of unrecognized devices below.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={async () => {
            if (othersCount === 0) return;
            const ok = await confirm({
              title: "Revoke other sessions",
              message: `Sign out of ${othersCount} other session${
                othersCount === 1 ? "" : "s"
              }? They will need to sign in again.`,
              confirmLabel: "Revoke all",
              variant: "warning",
            });
            if (ok) revokeOthers.mutate();
          }}
          disabled={othersCount === 0 || revokeOthers.isPending}
        >
          Revoke all other sessions
        </Button>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-950/40">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Device
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  IP
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Last used
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Expires
                </th>
                <th className="w-24 px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                    {Array.from({ length: 5 }).map((__, j) => (
                      <td key={j} className="px-4 py-3">
                        <Skeleton className="h-4 w-full max-w-[160px]" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-0">
                    <EmptyState
                      icon={Monitor}
                      title="No active sessions"
                      description="You'll be listed here the next time you sign in."
                      className="border-0 bg-transparent py-10 dark:bg-transparent"
                    />
                  </td>
                </tr>
              ) : (
                data.map((s) => {
                  const parsed = parseUserAgent(s.userAgent);
                  return (
                    <tr
                      key={s.id}
                      className={
                        s.isCurrent
                          ? "border-t border-gray-100 bg-emerald-50/50 dark:border-gray-800 dark:bg-emerald-950/20"
                          : "border-t border-gray-100 dark:border-gray-800"
                      }
                    >
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-200">
                        <div className="flex items-center gap-2">
                          <span>{parsed.summary}</span>
                          {s.isCurrent ? <Badge variant="ok">Current</Badge> : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {s.ipAddress || "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {formatDateTime(s.updatedAt || s.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {formatDateTime(s.expiresAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {s.isCurrent ? (
                          <span
                            className="inline-flex cursor-not-allowed items-center gap-1 text-xs text-gray-400"
                            title="Use Sign Out instead"
                          >
                            <Info className="h-3.5 w-3.5" />
                            Use Sign Out
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              const ok = await confirm({
                                title: "Revoke session",
                                message: `Sign out of ${parsed.summary}?`,
                                confirmLabel: "Revoke",
                                variant: "warning",
                              });
                              if (ok) revokeOne.mutate(s.id);
                            }}
                            disabled={revokeOne.isPending}
                          >
                            <Trash2 />
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
