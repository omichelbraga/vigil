"use client";

import { useMemo, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as Dialog from "@radix-ui/react-dialog";
import {
  UserPlus,
  MoreHorizontal,
  ShieldCheck,
  ShieldOff,
  LogOut,
  Trash2,
  KeyRound,
  CheckCircle2,
  XCircle,
  Info,
  Copy,
  Check,
} from "lucide-react";

import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type Role = "admin" | "editor" | "viewer";

interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
  disabledAt: string | null;
  lastSignInAt: string | null;
  sessionsCount: number;
  mfaEnabled: boolean;
  createdAt: string;
}

interface InviteResponse {
  success: boolean;
  user: { id: string; email: string; name: string; role: Role };
  emailSent: boolean;
  emailError: string | null;
  tempPassword?: string;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.floor(diffMo / 12);
  return `${diffYr}y ago`;
}

function roleBadgeVariant(role: Role): "ok" | "info" | "muted" {
  if (role === "admin") return "ok"; // emerald
  if (role === "editor") return "info"; // sky
  return "muted"; // slate
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

export default function AdminUsersPage(): React.ReactElement {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResponse | null>(null);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);

  const usersQuery = useQuery<AdminUserRow[]>({
    queryKey: ["admin", "users"],
    queryFn: () => apiJson<AdminUserRow[]>("/api/admin/users"),
    refetchOnWindowFocus: false,
  });

  // Optimistic PATCH
  const patchUserMutation = useMutation({
    mutationFn: async (input: {
      id: string;
      patch: { role?: Role; name?: string; disabled?: boolean };
    }) =>
      apiJson<{ id: string; role: Role; name: string; email: string }>(
        `/api/admin/users/${input.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.patch),
        },
      ),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["admin", "users"] });
      const prev = qc.getQueryData<AdminUserRow[]>(["admin", "users"]);
      if (prev) {
        qc.setQueryData<AdminUserRow[]>(
          ["admin", "users"],
          prev.map((u) =>
            u.id === id
              ? {
                  ...u,
                  ...(patch.role ? { role: patch.role } : {}),
                  ...(patch.name ? { name: patch.name } : {}),
                  ...(patch.disabled !== undefined
                    ? {
                        disabledAt: patch.disabled
                          ? new Date().toISOString()
                          : null,
                        sessionsCount: patch.disabled ? 0 : u.sessionsCount,
                      }
                    : {}),
                }
              : u,
          ),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin", "users"], ctx.prev);
      toast.error("Update failed", err instanceof Error ? err.message : String(err));
    },
    onSuccess: () => {
      toast.success("User updated");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (id: string) =>
      apiJson<{ success: true }>(`/api/admin/users/${id}`, {
        method: "DELETE",
      }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["admin", "users"] });
      const prev = qc.getQueryData<AdminUserRow[]>(["admin", "users"]);
      if (prev) {
        qc.setQueryData<AdminUserRow[]>(
          ["admin", "users"],
          prev.filter((u) => u.id !== id),
        );
      }
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin", "users"], ctx.prev);
      toast.error("Delete failed", err instanceof Error ? err.message : String(err));
    },
    onSuccess: () => toast.success("User deleted"),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });

  const forceLogoutMutation = useMutation({
    mutationFn: async (id: string) =>
      apiJson<{ success: true; sessionsRevoked: number }>(
        `/api/admin/users/${id}/force-logout`,
        { method: "POST" },
      ),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["admin", "users"] });
      const prev = qc.getQueryData<AdminUserRow[]>(["admin", "users"]);
      if (prev) {
        qc.setQueryData<AdminUserRow[]>(
          ["admin", "users"],
          prev.map((u) => (u.id === id ? { ...u, sessionsCount: 0 } : u)),
        );
      }
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin", "users"], ctx.prev);
      toast.error(
        "Force sign-out failed",
        err instanceof Error ? err.message : String(err),
      );
    },
    onSuccess: (res) =>
      toast.success(`Revoked ${res.sessionsRevoked} session(s)`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });

  const handleChangeRole = (id: string, role: Role) => {
    setRowMenuId(null);
    patchUserMutation.mutate({ id, patch: { role } });
  };

  const handleToggleDisabled = async (row: AdminUserRow) => {
    setRowMenuId(null);
    const disable = !row.disabledAt;
    const ok = await confirm({
      title: disable ? "Disable user" : "Enable user",
      message: disable
        ? `Disable ${row.email}? Active sessions will be revoked and they will not be able to sign in.`
        : `Re-enable ${row.email}?`,
      confirmLabel: disable ? "Disable" : "Enable",
      variant: disable ? "warning" : "info",
    });
    if (!ok) return;
    patchUserMutation.mutate({ id: row.id, patch: { disabled: disable } });
  };

  const handleForceLogout = async (row: AdminUserRow) => {
    setRowMenuId(null);
    const ok = await confirm({
      title: "Force sign-out",
      message: `Revoke all active sessions for ${row.email}?`,
      confirmLabel: "Sign them out",
      variant: "warning",
    });
    if (!ok) return;
    forceLogoutMutation.mutate(row.id);
  };

  const handleDelete = async (row: AdminUserRow) => {
    setRowMenuId(null);
    const ok = await confirm({
      title: "Delete user",
      message: `Permanently delete ${row.email}? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    deleteUserMutation.mutate(row.id);
  };

  const handleForceMfa = () => {
    setRowMenuId(null);
    // TODO: implement server-side MFA enforcement flag.
    alert("Force MFA is not yet implemented — coming soon.");
  };

  const columns = useMemo<ColumnDef<AdminUserRow, unknown>[]>(
    () => [
      {
        id: "email",
        accessorKey: "email",
        header: "Email",
        cell: ({ row }) => {
          const u = row.original;
          const initial =
            (u.name || u.email || "?").charAt(0).toUpperCase() || "?";
          return (
            <div className="flex items-center gap-3">
              {u.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={u.avatarUrl}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {initial}
                </div>
              )}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {u.email}
              </span>
            </div>
          );
        },
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="text-gray-700 dark:text-gray-300">
            {row.original.name || "—"}
          </span>
        ),
      },
      {
        id: "role",
        accessorKey: "role",
        header: () => (
          <span
            className="inline-flex items-center gap-1"
            title="admin: full control · editor: create+modify · viewer: read-only"
          >
            Role
            <Info className="h-3.5 w-3.5 opacity-60" />
          </span>
        ),
        cell: ({ row }) => (
          <Badge variant={roleBadgeVariant(row.original.role)}>
            {row.original.role}
          </Badge>
        ),
      },
      {
        id: "mfa",
        accessorKey: "mfaEnabled",
        header: "MFA",
        cell: ({ row }) =>
          row.original.mfaEnabled ? (
            <CheckCircle2
              className="h-4 w-4 text-emerald-500"
              aria-label="MFA enabled"
            />
          ) : (
            <XCircle
              className="h-4 w-4 text-gray-400"
              aria-label="MFA disabled"
            />
          ),
      },
      {
        id: "lastSignIn",
        accessorKey: "lastSignInAt",
        header: "Last sign-in",
        cell: ({ row }) => (
          <span className="text-gray-600 dark:text-gray-400">
            {relativeTime(row.original.lastSignInAt)}
          </span>
        ),
      },
      {
        id: "sessions",
        accessorKey: "sessionsCount",
        header: "Sessions",
        cell: ({ row }) => (
          <span className="tabular-nums text-gray-700 dark:text-gray-300">
            {row.original.sessionsCount}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "disabledAt",
        header: "Status",
        cell: ({ row }) =>
          row.original.disabledAt ? (
            <Badge variant="crit">Disabled</Badge>
          ) : (
            <Badge variant="ok">Active</Badge>
          ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const u = row.original;
          const isSelf = currentUserId === u.id;
          return (
            <RowActionMenu
              open={rowMenuId === u.id}
              onOpen={(v) => setRowMenuId(v ? u.id : null)}
              user={u}
              isSelf={isSelf}
              onChangeRole={(r) => handleChangeRole(u.id, r)}
              onForceLogout={() => handleForceLogout(u)}
              onForceMfa={handleForceMfa}
              onToggleDisabled={() => handleToggleDisabled(u)}
              onDelete={() => handleDelete(u)}
            />
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowMenuId, currentUserId],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Users
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage administrator, editor, and viewer access.
          </p>
        </div>
        <Button type="button" onClick={() => setInviteOpen(true)}>
          <UserPlus />
          Invite user
        </Button>
      </div>

      <DataTable<AdminUserRow>
        columns={columns}
        data={usersQuery.data ?? []}
        isLoading={usersQuery.isLoading}
        searchable
        searchPlaceholder="Search email or name..."
        globalFilterFn={(row, needle) => {
          const n = needle.toLowerCase();
          return (
            row.email.toLowerCase().includes(n) ||
            (row.name ?? "").toLowerCase().includes(n)
          );
        }}
        emptyTitle="No users"
        emptyDescription="Invite your first teammate to get started."
      />

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={(res) => {
          setInviteOpen(false);
          setInviteResult(res);
          setResultOpen(true);
          qc.invalidateQueries({ queryKey: ["admin", "users"] });
        }}
      />

      <InviteResultDialog
        open={resultOpen}
        result={inviteResult}
        onClose={() => {
          setResultOpen(false);
          setInviteResult(null);
        }}
      />
    </div>
  );
}

/* ────────────────────────────────── row actions ─────────────────────────── */

interface RowActionMenuProps {
  open: boolean;
  onOpen: (v: boolean) => void;
  user: AdminUserRow;
  isSelf: boolean;
  onChangeRole: (r: Role) => void;
  onForceLogout: () => void;
  onForceMfa: () => void;
  onToggleDisabled: () => void;
  onDelete: () => void;
}

function RowActionMenu({
  open,
  onOpen,
  user,
  isSelf,
  onChangeRole,
  onForceLogout,
  onForceMfa,
  onToggleDisabled,
  onDelete,
}: RowActionMenuProps): React.ReactElement {
  const [submenu, setSubmenu] = useState<"role" | null>(null);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Row actions"
        onClick={() => {
          setSubmenu(null);
          onOpen(!open);
        }}
      >
        <MoreHorizontal />
      </Button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => {
              setSubmenu(null);
              onOpen(false);
            }}
          />
          <div
            role="menu"
            className={cn(
              "absolute right-0 z-40 mt-1 w-52 overflow-hidden rounded-lg border border-gray-200 bg-white text-sm shadow-lg",
              "dark:border-gray-800 dark:bg-gray-900",
            )}
          >
            {submenu === "role" ? (
              <div className="py-1">
                <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Set role
                </div>
                {(["admin", "editor", "viewer"] as const).map((r) => (
                  <button
                    type="button"
                    key={r}
                    disabled={user.role === r}
                    onClick={() => onChangeRole(r)}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-2 text-left",
                      "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800",
                      "disabled:opacity-50 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent",
                    )}
                  >
                    <span className="capitalize">{r}</span>
                    {user.role === r ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : null}
                  </button>
                ))}
                <div className="border-t border-gray-100 dark:border-gray-800" />
                <button
                  type="button"
                  onClick={() => setSubmenu(null)}
                  className="w-full px-3 py-2 text-left text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Back
                </button>
              </div>
            ) : (
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => setSubmenu("role")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Change role
                </button>
                <button
                  type="button"
                  onClick={onForceLogout}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  <LogOut className="h-4 w-4" />
                  Force sign-out
                </button>
                <button
                  type="button"
                  onClick={onForceMfa}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  <KeyRound className="h-4 w-4" />
                  Force MFA
                </button>
                <button
                  type="button"
                  onClick={onToggleDisabled}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  <ShieldOff className="h-4 w-4" />
                  {user.disabledAt ? "Enable" : "Disable"}
                </button>
                <div className="border-t border-gray-100 dark:border-gray-800" />
                <button
                  type="button"
                  disabled={isSelf}
                  onClick={onDelete}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left",
                    "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40",
                    "disabled:opacity-50 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent",
                  )}
                  title={isSelf ? "You cannot delete yourself" : undefined}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────── invite dialog ───────────────────────── */

interface InviteDialogProps {
  open: boolean;
  onClose: () => void;
  onInvited: (res: InviteResponse) => void;
}

function InviteDialog({
  open,
  onClose,
  onInvited,
}: InviteDialogProps): React.ReactElement {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [sendEmail, setSendEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmail("");
    setName("");
    setRole("viewer");
    setSendEmail(true);
    setError(null);
    setSubmitting(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Enter a valid email address");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiJson<InviteResponse>("/api/admin/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          name: name.trim() || undefined,
          role,
          sendEmail,
        }),
      });
      toast.success(`Invited ${trimmed}`);
      reset();
      onInvited(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
            Invite user
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Create a new account with a temporary password.
          </Dialog.Description>

          <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit}>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Email <span className="text-rose-500">*</span>
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Display name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Role
              </span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
              >
                <option value="viewer">Viewer — read-only</option>
                <option value="editor">Editor — create + modify</option>
                <option value="admin">Admin — full control</option>
              </select>
            </label>

            <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950/40">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                className="mt-0.5 accent-emerald-600"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                <span className="font-medium">Send invite email</span>
                <br />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  If disabled (or SMTP not configured), the temporary password is
                  shown to you after creation so you can share it manually.
                </span>
              </span>
            </label>

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
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Inviting..." : "Invite"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ────────────────────────────────── invite result ───────────────────────── */

interface InviteResultDialogProps {
  open: boolean;
  result: InviteResponse | null;
  onClose: () => void;
}

function InviteResultDialog({
  open,
  result,
  onClose,
}: InviteResultDialogProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const tempPassword = result?.tempPassword;

  const copy = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
            User invited
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {result?.user.email} is now a{" "}
            <span className="font-medium">{result?.user.role}</span>.
          </Dialog.Description>

          <div className="mt-5 space-y-3">
            {result?.emailSent ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                Invite email delivered. The temporary password has been sent to
                the user.
              </div>
            ) : null}

            {result?.emailError ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                Email delivery failed: {result.emailError}. Share the password
                below manually.
              </div>
            ) : null}

            {tempPassword ? (
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Temporary password
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 select-all rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                    {tempPassword}
                  </code>
                  <Button type="button" variant="outline" size="sm" onClick={copy}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Share this with the user via a secure channel. It will not be
                  shown again.
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
