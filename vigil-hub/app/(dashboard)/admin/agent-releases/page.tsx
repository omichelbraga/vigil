"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Package,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast-provider";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/* ──────────────────────────────────────── types ────────────────────────── */

interface ReleaseRow {
  id: string;
  os: string;
  arch: string;
  version: string;
  artifactType: string; // "exe-update" | "msi-installer"
  sha256: string;
  filename: string;
  filePath: string | null;
  fileSize: string | null;
  isActive: boolean;
  signature: string | null;
  signedBy: string | null;
  signatureValid: boolean;
  uploadedBy: string | null;
  uploadedByEmail: string | null;
  uploadedAt: string;
  downloadUrl: string;
}

type ArtifactType = "exe-update" | "msi-installer";

interface RunningVersionMap {
  [osArch: string]: { [version: string]: number };
}

interface ReleasesPayload {
  releases: ReleaseRow[];
  runningVersions: RunningVersionMap;
  signingKey: { fingerprint: string } | null;
}

type Os = "linux" | "windows";
type Arch = "amd64" | "arm64";

/* ──────────────────────────────────────── helpers ──────────────────────── */

const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

function formatBytes(bytesStr: string | null): string {
  if (!bytesStr) return "—";
  const bytes = Number(bytesStr);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / 1_048_576;
  return `${mb.toFixed(mb >= 100 ? 0 : mb >= 10 ? 1 : 2)} MB`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return "—";
  const sec = Math.max(0, Math.round(delta / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed: ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

/* ──────────────────────────────────────── page ─────────────────────────── */

export default function AdminAgentReleasesPage(): React.ReactElement {
  const { data: session, isPending } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const releasesQuery = useQuery<ReleasesPayload>({
    queryKey: ["admin", "agent-releases"],
    queryFn: () => apiJson<ReleasesPayload>("/api/admin/agent-releases"),
    enabled: role === "admin",
    refetchOnWindowFocus: false,
  });

  const patchMutation = useMutation({
    mutationFn: async (input: {
      id: string;
      patch: { isActive?: boolean };
    }) =>
      apiJson<ReleaseRow>(`/api/admin/agent-releases/${input.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input.patch),
      }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["admin", "agent-releases"] });
      const prev = qc.getQueryData<ReleasesPayload>([
        "admin",
        "agent-releases",
      ]);
      if (prev && patch.isActive !== undefined) {
        const target = prev.releases.find((r) => r.id === id);
        if (target) {
          qc.setQueryData<ReleasesPayload>(
            ["admin", "agent-releases"],
            {
              ...prev,
              releases: prev.releases.map((r) => {
                if (r.id === id) return { ...r, isActive: patch.isActive! };
                if (
                  patch.isActive &&
                  r.os === target.os &&
                  r.arch === target.arch
                ) {
                  return { ...r, isActive: false };
                }
                return r;
              }),
            },
          );
        }
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin", "agent-releases"], ctx.prev);
      toast.error(
        "Update failed",
        err instanceof Error ? err.message : String(err),
      );
    },
    onSuccess: (_r, vars) => {
      toast.success(
        vars.patch.isActive ? "Release activated" : "Release deactivated",
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["admin", "agent-releases"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      apiJson<{ success: true }>(`/api/admin/agent-releases/${id}`, {
        method: "DELETE",
      }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["admin", "agent-releases"] });
      const prev = qc.getQueryData<ReleasesPayload>([
        "admin",
        "agent-releases",
      ]);
      if (prev) {
        qc.setQueryData<ReleasesPayload>(["admin", "agent-releases"], {
          ...prev,
          releases: prev.releases.filter((r) => r.id !== id),
        });
      }
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin", "agent-releases"], ctx.prev);
      toast.error(
        "Delete failed",
        err instanceof Error ? err.message : String(err),
      );
    },
    onSuccess: () => toast.success("Release deleted"),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["admin", "agent-releases"] });
    },
  });

  const handleCopyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(
        () => setCopiedHash((v) => (v === hash ? null : v)),
        1500,
      );
    } catch {
      /* noop */
    }
  };

  const handleToggleActive = (row: ReleaseRow) => {
    patchMutation.mutate({
      id: row.id,
      patch: { isActive: !row.isActive },
    });
  };

  const handleDelete = async (row: ReleaseRow) => {
    const ok = await confirm({
      title: "Delete release",
      message: `Delete ${row.os}/${row.arch} v${row.version}? This removes the binary from disk and the database. Agents currently on this version will stop receiving updates.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    deleteMutation.mutate(row.id);
  };

  const columns = useMemo<ColumnDef<ReleaseRow, unknown>[]>(
    () => [
      {
        id: "platform",
        header: "Platform + Version",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex flex-col">
              <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                {r.os}/{r.arch}
              </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                v{r.version}
              </span>
            </div>
          );
        },
      },
      {
        id: "artifactType",
        header: "Channel",
        cell: ({ row }) => {
          const r = row.original;
          if (r.artifactType === "msi-installer") {
            return (
              <Badge
                variant="ok"
                title="Windows MSI installer (served via /api/install/agent/windows/amd64)"
              >
                msi
              </Badge>
            );
          }
          return (
            <Badge
              variant="muted"
              title="In-place auto-update binary (served via /api/update/agent/...)"
            >
              exe-update
            </Badge>
          );
        },
      },
      {
        id: "sha256",
        header: "SHA-256",
        cell: ({ row }) => {
          const r = row.original;
          const short = r.sha256.slice(0, 16);
          const isCopied = copiedHash === r.sha256;
          return (
            <button
              type="button"
              onClick={() => handleCopyHash(r.sha256)}
              title="Click to copy full hash"
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {short}
              {isCopied ? (
                <Check className="h-3 w-3 text-emerald-500" />
              ) : (
                <Copy className="h-3 w-3 opacity-60" />
              )}
            </button>
          );
        },
      },
      {
        id: "signature",
        header: "Signature",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.signature) {
            return (
              <Badge variant="muted" title="Unsigned release">
                <XCircle className="h-3 w-3" />
                unsigned
              </Badge>
            );
          }
          if (r.signatureValid) {
            return (
              <Badge
                variant="ok"
                title={`Signed by ${r.signedBy ?? "?"} (valid)`}
              >
                <CheckCircle2 className="h-3 w-3" />
                valid
              </Badge>
            );
          }
          return (
            <Badge
              variant="crit"
              title="Signature present but does not verify against configured pubkey"
            >
              <XCircle className="h-3 w-3" />
              invalid
            </Badge>
          );
        },
      },
      {
        id: "size",
        header: "Size",
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-700 dark:text-gray-300">
            {formatBytes(row.original.fileSize)}
          </span>
        ),
      },
      {
        id: "active",
        header: "Active",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <button
              type="button"
              role="switch"
              aria-checked={r.isActive}
              onClick={() => handleToggleActive(r)}
              disabled={patchMutation.isPending}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                r.isActive ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-700",
                patchMutation.isPending && "opacity-60",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                  r.isActive ? "translate-x-4" : "translate-x-0",
                )}
              />
            </button>
          );
        },
      },
      {
        id: "uploader",
        header: "Uploaded",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex flex-col">
              <span className="text-gray-900 dark:text-gray-100">
                {r.uploadedByEmail ?? (r.uploadedBy ? "unknown" : "—")}
              </span>
              <span
                className="text-xs text-gray-500 dark:text-gray-400"
                title={new Date(r.uploadedAt).toLocaleString()}
              >
                {relativeTime(r.uploadedAt)}
              </span>
            </div>
          );
        },
      },
      {
        id: "download",
        header: "Download",
        cell: ({ row }) => (
          <a
            href={row.original.downloadUrl}
            download={row.original.filename}
            className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-1 font-mono text-xs text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-900"
          >
            ↓ {row.original.filename}
          </a>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleToggleActive(r)}
                disabled={patchMutation.isPending}
                title={r.isActive ? "Deactivate" : "Activate"}
              >
                {r.isActive ? (
                  <ShieldOff className="h-3 w-3" />
                ) : (
                  <ShieldCheck className="h-3 w-3" />
                )}
                {r.isActive ? "Deactivate" : "Activate"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleDelete(r)}
                disabled={deleteMutation.isPending}
                title="Delete release"
                className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </Button>
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [copiedHash, patchMutation.isPending, deleteMutation.isPending],
  );

  if (isPending) {
    return <Skeleton className="h-10 w-40" />;
  }
  if (role !== "admin") {
    return (
      <EmptyState
        title="Admin only"
        description="You need the admin role to manage agent releases."
      />
    );
  }

  const data = releasesQuery.data;
  const releases = data?.releases ?? [];
  const runningVersions = data?.runningVersions ?? {};
  const signingKey = data?.signingKey ?? null;

  // Compute drift: agents whose reported version differs from the active
  // release for their (os). We group only by os — agents don't always
  // report arch, so os-level comparison is the most reliable signal.
  const activeByOs = new Map<string, string>();
  for (const r of releases) {
    if (r.isActive) activeByOs.set(r.os.toLowerCase(), r.version);
  }
  const drift: { os: string; version: string; count: number; expected: string }[] = [];
  for (const [osKey, versionMap] of Object.entries(runningVersions)) {
    const expected = activeByOs.get(osKey);
    if (!expected) continue;
    for (const [reportedVersion, count] of Object.entries(versionMap)) {
      if (reportedVersion !== expected) {
        drift.push({ os: osKey, version: reportedVersion, count, expected });
      }
    }
  }
  drift.sort((a, b) => b.count - a.count);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Agent releases
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Upload, sign, and activate the binaries distributed to Vigil agents
            via the auto-update channel.
          </p>
          {signingKey ? (
            <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs dark:border-emerald-900/60 dark:bg-emerald-950/40">
              <KeyRound className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-emerald-800 dark:text-emerald-200">
                Signing key:{" "}
                <code className="font-mono font-semibold">
                  {signingKey.fingerprint}
                </code>
              </span>
            </div>
          ) : null}
        </div>
        <Button type="button" onClick={() => setUploadOpen(true)}>
          <Upload />
          Upload release
        </Button>
      </div>

      {!signingKey ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/40">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="text-amber-800 dark:text-amber-200">
            <p className="font-medium">No signing key configured</p>
            <p className="mt-0.5 text-amber-700 dark:text-amber-300">
              Agents will refuse updates from unsigned or unverifiable releases.
              Set <code className="font-mono">VIGIL_UPDATE_PUBKEY</code> to the
              64-hex ed25519 public key and restart the hub.
            </p>
          </div>
        </div>
      ) : null}

      {releasesQuery.error ? (
        <Card>
          <CardContent className="p-6 text-sm text-rose-600 dark:text-rose-400">
            {releasesQuery.error instanceof Error
              ? releasesQuery.error.message
              : "Failed to load releases."}
          </CardContent>
        </Card>
      ) : null}

      <DataTable<ReleaseRow>
        columns={columns}
        data={releases}
        isLoading={releasesQuery.isLoading}
        searchable
        searchPlaceholder="Search version, os, arch..."
        globalFilterFn={(row, needle) => {
          const n = needle.toLowerCase();
          return (
            row.version.toLowerCase().includes(n) ||
            row.os.toLowerCase().includes(n) ||
            row.arch.toLowerCase().includes(n) ||
            row.sha256.toLowerCase().includes(n)
          );
        }}
        emptyTitle="No releases uploaded"
        emptyDescription="Upload a signed agent binary to start distributing updates to the fleet."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-emerald-500" />
            Agents running non-active versions
          </CardTitle>
          <CardDescription>
            Grouped by OS. Agents drift when auto-update is off, when a newer
            release was activated but rollouts haven&apos;t completed, or when
            a host was offline during rollout.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {drift.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              All reporting agents match the active release for their platform.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-950/40">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      OS
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Reported version
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Active release
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Agents
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drift.map((d) => (
                    <tr
                      key={`${d.os}-${d.version}`}
                      className="border-t border-gray-100 dark:border-gray-800"
                    >
                      <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {d.os}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">
                        {d.version}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">
                        v{d.expected}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">
                        {d.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setUploadOpen(false);
          qc.invalidateQueries({ queryKey: ["admin", "agent-releases"] });
        }}
      />
    </div>
  );
}

/* ──────────────────────────────────────── upload dialog ────────────────── */

interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

function UploadDialog({
  open,
  onClose,
  onUploaded,
}: UploadDialogProps): React.ReactElement {
  const toast = useToast();
  const [os, setOs] = useState<Os>("linux");
  const [arch, setArch] = useState<Arch>("amd64");
  const [artifactType, setArtifactType] = useState<ArtifactType>("exe-update");
  const [version, setVersion] = useState("");
  const [signature, setSignature] = useState("");
  const [signedBy, setSignedBy] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOs("linux");
    setArch("amd64");
    setArtifactType("exe-update");
    setVersion("");
    setSignature("");
    setSignedBy("");
    setFile(null);
    setUploading(false);
    setProgress(0);
    setError(null);
  };

  // MSI is Windows-only. Auto-flip os when switching artifact type so the
  // server-side validation (msi-installer requires os=windows) never fails
  // the user mid-form.
  const handleArtifactTypeChange = (next: ArtifactType) => {
    setArtifactType(next);
    if (next === "msi-installer" && os !== "windows") {
      setOs("windows");
    }
  };

  const versionValid = version.length === 0 || VERSION_RE.test(version);
  const sigValid =
    signature.length === 0 ||
    (signature.length === 128 && HEX_RE.test(signature));
  const fpValid =
    signedBy.length === 0 || (signedBy.length === 8 && HEX_RE.test(signedBy));

  const canSubmit =
    !uploading &&
    file !== null &&
    version.length > 0 &&
    VERSION_RE.test(version) &&
    sigValid &&
    fpValid;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !canSubmit) return;
    setError(null);
    setUploading(true);
    setProgress(0);

    const form = new FormData();
    form.append("os", os);
    form.append("arch", arch);
    form.append("artifactType", artifactType);
    form.append("version", version);
    if (signature) form.append("signature", signature);
    if (signedBy) form.append("signedBy", signedBy);
    form.append("file", file);

    // Use XMLHttpRequest so we can wire up real upload progress — fetch()
    // doesn't expose an upload-progress event.
    const payload = await new Promise<{
      ok: boolean;
      status: number;
      body: string;
    }>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/agent-releases/upload");
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          setProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      };
      xhr.onload = () =>
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          body: xhr.responseText,
        });
      xhr.onerror = () =>
        resolve({ ok: false, status: 0, body: "Network error" });
      xhr.send(form);
    });

    setUploading(false);

    if (!payload.ok) {
      let msg = payload.body;
      try {
        const json = JSON.parse(payload.body) as { error?: string };
        if (json?.error) msg = json.error;
      } catch {
        /* keep raw body */
      }
      setError(msg || `Upload failed (${payload.status})`);
      return;
    }

    toast.success(`Uploaded ${os}/${arch} v${version}`);
    reset();
    onUploaded();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v && !uploading) {
          reset();
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
            Upload agent release
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Stream a signed agent binary into the distribution channel. The hub
            computes SHA-256 inline while writing to disk.
          </Dialog.Description>

          <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit}>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Distribution channel <span className="text-rose-500">*</span>
              </span>
              <select
                value={artifactType}
                onChange={(e) =>
                  handleArtifactTypeChange(e.target.value as ArtifactType)
                }
                disabled={uploading}
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                <option value="exe-update">
                  exe-update — auto-update channel (signed .exe / ELF)
                </option>
                <option value="msi-installer">
                  msi-installer — Windows first-install (.msi)
                </option>
              </select>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {artifactType === "msi-installer"
                  ? "Served from /api/install/agent/windows/amd64 with an enrollment token. Authenticode signing is separate from the ed25519 chain below."
                  : "Served from /api/update/agent/.../download to agents that already have a hub bearer token. Sign with scripts/sign-release.sh."}
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  OS <span className="text-rose-500">*</span>
                </span>
                <select
                  value={os}
                  onChange={(e) => setOs(e.target.value as Os)}
                  disabled={uploading || artifactType === "msi-installer"}
                  className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="linux">linux</option>
                  <option value="windows">windows</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  Arch <span className="text-rose-500">*</span>
                </span>
                <select
                  value={arch}
                  onChange={(e) => setArch(e.target.value as Arch)}
                  disabled={uploading}
                  className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                >
                  <option value="amd64">amd64</option>
                  <option value="arm64">arm64</option>
                </select>
              </label>
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Version <span className="text-rose-500">*</span>
              </span>
              <input
                type="text"
                required
                value={version}
                onChange={(e) => setVersion(e.target.value.trim())}
                disabled={uploading}
                placeholder="0.2.0 or 0.2.0-beta.1"
                className={cn(
                  "h-9 rounded-lg border bg-white px-3 font-mono text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-gray-950 dark:text-gray-100",
                  versionValid
                    ? "border-gray-300 dark:border-gray-700"
                    : "border-rose-400 dark:border-rose-700",
                )}
              />
              {!versionValid ? (
                <span className="text-xs text-rose-500">
                  Must match semver pattern (e.g. 1.2.3 or 1.2.3-rc.1).
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Signature (hex, optional)
              </span>
              <input
                type="text"
                value={signature}
                onChange={(e) => setSignature(e.target.value.trim())}
                disabled={uploading}
                placeholder="128 hex chars — ed25519 signature over sha256 hex"
                className={cn(
                  "h-9 rounded-lg border bg-white px-3 font-mono text-xs text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-gray-950 dark:text-gray-100",
                  sigValid
                    ? "border-gray-300 dark:border-gray-700"
                    : "border-rose-400 dark:border-rose-700",
                )}
              />
              {!sigValid ? (
                <span className="text-xs text-rose-500">
                  Must be exactly 128 hex characters.
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Signed-by fingerprint (8 hex, optional)
              </span>
              <input
                type="text"
                value={signedBy}
                onChange={(e) => setSignedBy(e.target.value.trim())}
                disabled={uploading}
                placeholder="abcdef12"
                className={cn(
                  "h-9 rounded-lg border bg-white px-3 font-mono text-xs text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-gray-950 dark:text-gray-100",
                  fpValid
                    ? "border-gray-300 dark:border-gray-700"
                    : "border-rose-400 dark:border-rose-700",
                )}
              />
              {!fpValid ? (
                <span className="text-xs text-rose-500">
                  Must be exactly 8 hex characters.
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Binary <span className="text-rose-500">*</span>
              </span>
              <input
                type="file"
                required
                accept={
                  artifactType === "msi-installer"
                    ? ".msi,application/x-msi"
                    : ".exe,application/octet-stream"
                }
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                disabled={uploading}
                className="block w-full cursor-pointer rounded-lg border border-gray-300 bg-white text-sm text-gray-900 file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:file:bg-gray-800 dark:file:text-gray-200"
              />
              {file ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {file.name} · {(file.size / 1_048_576).toFixed(2)} MB
                </span>
              ) : null}
            </label>

            {uploading ? (
              <div className="flex flex-col gap-1.5">
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Uploading... {progress}%
                </span>
              </div>
            ) : null}

            {error ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
                {error}
              </div>
            ) : null}

            <div className="mt-2 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  reset();
                  onClose();
                }}
                disabled={uploading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {uploading ? "Uploading..." : "Upload"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
