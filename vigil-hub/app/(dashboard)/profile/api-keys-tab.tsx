"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  KeyRound,
  Plus,
  Trash2,
  Check,
  Copy,
  AlertTriangle,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import type { ApiKey, ApiKeyCreateResponse } from "./profile-types";

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500";
const labelClass =
  "block text-sm font-medium text-gray-700 dark:text-gray-300";

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

interface CreateFormState {
  name: string;
  scopes: { read: boolean; write: boolean; admin: boolean };
  expiry: "never" | "30d" | "90d" | "1y";
}

const DEFAULT_FORM: CreateFormState = {
  name: "",
  scopes: { read: true, write: false, admin: false },
  expiry: "never",
};

export function ApiKeysTab(): React.ReactElement {
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();
  const confirm = useConfirm();

  const [showRevoked, setShowRevoked] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateFormState>(DEFAULT_FORM);
  const [created, setCreated] = useState<ApiKeyCreateResponse | null>(null);
  const [showPlaintext, setShowPlaintext] = useState(false);
  const [copied, setCopied] = useState(false);

  const keys = useQuery({
    queryKey: ["profile", "api-keys", showRevoked],
    queryFn: async (): Promise<ApiKey[]> => {
      const res = await fetch(
        `/api/profile/api-keys${showRevoked ? "?showRevoked=true" : ""}`,
      );
      if (!res.ok) throw new Error("Failed to load API keys");
      return (await res.json()) as ApiKey[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (): Promise<ApiKeyCreateResponse> => {
      const scopes = (["read", "write", "admin"] as const).filter(
        (s) => form.scopes[s],
      );
      const res = await fetch("/api/profile/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          scopes,
          expiresAt: form.expiry,
        }),
      });
      const data = (await res.json()) as
        | ApiKeyCreateResponse
        | { error: string };
      if (!res.ok || !("plaintext" in data)) {
        throw new Error(("error" in data ? data.error : null) || "Create failed");
      }
      return data;
    },
    onSuccess: (data) => {
      setCreated(data);
      setCreateOpen(false);
      setForm(DEFAULT_FORM);
      void qc.invalidateQueries({ queryKey: ["profile", "api-keys"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Create failed";
      toastError("Could not create API key", message);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/api/profile/api-keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed");
      }
    },
    onSuccess: () => {
      success("API key revoked");
      void qc.invalidateQueries({ queryKey: ["profile", "api-keys"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed";
      toastError("Could not revoke", message);
    },
  });

  const data = keys.data ?? [];
  const scopeCount = Object.values(form.scopes).filter(Boolean).length;
  const canCreate = form.name.trim().length > 0 && scopeCount > 0;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
            <KeyRound className="h-5 w-5 text-emerald-500" />
            API keys
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Personal tokens for automation. The plaintext is shown once at creation
            time — store it securely.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-emerald-600"
            />
            Show revoked
          </label>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Create API key
          </Button>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-950/40">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Name
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Prefix
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Scopes
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Last used
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Expires
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Created
                </th>
                <th className="w-24 px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-4 py-3">
                        <Skeleton className="h-4 w-full max-w-[140px]" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    <EmptyState
                      icon={KeyRound}
                      title="No API keys"
                      description="Create a personal token to authenticate scripted access."
                      className="border-0 bg-transparent py-10 dark:bg-transparent"
                    />
                  </td>
                </tr>
              ) : (
                data.map((k) => {
                  const expired =
                    k.expiresAt != null &&
                    !Number.isNaN(new Date(k.expiresAt).getTime()) &&
                    new Date(k.expiresAt).getTime() < Date.now();
                  const revoked = k.revokedAt != null;
                  return (
                    <tr
                      key={k.id}
                      className="border-t border-gray-100 dark:border-gray-800"
                    >
                      <td className="px-4 py-3 text-gray-900 dark:text-gray-100">
                        <div className="flex items-center gap-2">
                          {k.name}
                          {revoked ? (
                            <Badge variant="muted">Revoked</Badge>
                          ) : expired ? (
                            <Badge variant="warn">Expired</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
                        {k.tokenPrefix}…
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <Badge key={s} variant="info">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {formatDateTime(k.lastUsedAt)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {k.expiresAt ? formatDateTime(k.expiresAt) : "Never"}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {formatDateTime(k.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {revoked ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              const ok = await confirm({
                                title: "Revoke API key",
                                message: `Revoke "${k.name}"? Any service using this key will fail to authenticate.`,
                                confirmLabel: "Revoke",
                                variant: "warning",
                              });
                              if (ok) revokeMutation.mutate(k.id);
                            }}
                            disabled={revokeMutation.isPending}
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

      {/* Create dialog */}
      <Dialog.Root
        open={createOpen}
        onOpenChange={(o) => {
          if (!o && !createMutation.isPending) {
            setCreateOpen(false);
            setForm(DEFAULT_FORM);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
            <Dialog.Title className="text-base font-semibold text-gray-900 dark:text-white">
              Create API key
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Give your new token a recognisable name and choose its capabilities.
            </Dialog.Description>

            <div className="mt-4 space-y-4">
              <div>
                <label className={labelClass}>Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="CI pipeline"
                  className={cn(inputClass, "mt-1")}
                />
              </div>

              <div>
                <label className={labelClass}>Scopes</label>
                <div className="mt-1 flex flex-wrap gap-3">
                  {(
                    [
                      { key: "read", label: "read" },
                      { key: "write", label: "write" },
                      { key: "admin", label: "admin" },
                    ] as const
                  ).map((s) => (
                    <label
                      key={s.key}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                    >
                      <input
                        type="checkbox"
                        checked={form.scopes[s.key]}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            scopes: { ...f.scopes, [s.key]: e.target.checked },
                          }))
                        }
                        className="h-4 w-4 rounded border-gray-300 text-emerald-600"
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
                {scopeCount === 0 ? (
                  <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                    Pick at least one scope.
                  </p>
                ) : null}
              </div>

              <div>
                <label className={labelClass}>Expires</label>
                <select
                  value={form.expiry}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      expiry: e.target.value as CreateFormState["expiry"],
                    }))
                  }
                  className={cn(inputClass, "mt-1")}
                >
                  <option value="never">Never</option>
                  <option value="30d">30 days</option>
                  <option value="90d">90 days</option>
                  <option value="1y">1 year</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreateOpen(false);
                    setForm(DEFAULT_FORM);
                  }}
                  disabled={createMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={!canCreate || createMutation.isPending}
                >
                  {createMutation.isPending ? "Creating…" : "Create key"}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Plaintext display dialog — shown once */}
      <Dialog.Root
        open={created !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCreated(null);
            setShowPlaintext(false);
            setCopied(false);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Save this token now
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              This is the only time the plaintext will be shown. Treat it like a
              password.
            </Dialog.Description>

            {created ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <code
                    className={cn(
                      "flex-1 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-950",
                    )}
                  >
                    {showPlaintext
                      ? created.plaintext
                      : "•".repeat(Math.min(40, created.plaintext.length))}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={showPlaintext ? "Hide" : "Show"}
                    onClick={() => setShowPlaintext((v) => !v)}
                  >
                    {showPlaintext ? <EyeOff /> : <Eye />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(created.plaintext);
                        setCopied(true);
                        success("Copied to clipboard");
                        window.setTimeout(() => setCopied(false), 2000);
                      } catch {
                        /* ignore */
                      }
                    }}
                  >
                    {copied ? <Check /> : <Copy />}
                  </Button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Key name: <span className="font-mono">{created.name}</span> · Prefix:{" "}
                  <span className="font-mono">{created.tokenPrefix}</span>
                </p>
                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      setCreated(null);
                      setShowPlaintext(false);
                      setCopied(false);
                    }}
                  >
                    I&apos;ve saved it, close
                  </Button>
                </div>
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
