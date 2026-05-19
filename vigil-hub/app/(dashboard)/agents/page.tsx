"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Server,
  Plus,
  Trash2,
  Eye,
  Copy,
  Check,
  AlertTriangle,
  Activity,
  ShieldCheck,
  ShieldOff,
  KeyRound,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Agent {
  id: string;
  name: string;
  status: string;
  os?: string;
  version?: string;
  hostname?: string;
  ip_address?: string;
  last_seen?: string;
  check_count?: number;
  /** True once the Hub has pinned an ed25519 signing pubkey (P6.4). */
  result_signing_pinned?: boolean;
  /** First 16 hex chars of the pinned pubkey — for admin debugging. */
  result_signing_pubkey_prefix?: string | null;
  result_signing_pinned_at?: string | null;
}

export default function AgentsPage() {
  // Browser-side URL = the exact origin the user loaded the dashboard from,
  // so the displayed enroll command works on whatever host/port the Hub is
  // currently served at. NEXT_PUBLIC_APP_URL is inlined at build time and
  // would bake in a stale value if the Hub gets reverse-proxied later.
  const hubUrl =
    typeof window !== "undefined" ? window.location.origin : "";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollToken, setEnrollToken] = useState<{token: string; expiresAt: string} | null>(null);
  const [enrollSeconds, setEnrollSeconds] = useState(0);
  const [pendingAgents, setPendingAgents] = useState<Agent[]>([]);
  const { success, error: toastError } = useToast();
  const confirm = useConfirm();

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      const all = Array.isArray(data) ? data : [];
      setPendingAgents(all.filter((a: Agent) => a.status === "pending"));
      setAgents(all.filter((a: Agent) => a.status !== "pending"));
    } catch (err) {
      console.error("Failed to fetch agents:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Live agent status via SSE
  useEffect(() => {
    const es = new EventSource("/api/sse");
    es.addEventListener("agent_status", (e) => {
      try {
        const statuses: { id: string; status: string }[] = JSON.parse(e.data);
        setAgents((prev) =>
          prev.map((a) => {
            const match = statuses.find((s) => s.id === a.id);
            return match ? { ...a, status: match.status } : a;
          })
        );
      } catch {}
    });
    return () => es.close();
  }, []);

  // Countdown timer for enrollment
  useEffect(() => {
    if (!enrollOpen) return;
    const interval = setInterval(() => {
      setEnrollSeconds((s) => {
        if (s <= 1) {
          setEnrollOpen(false);
          setEnrollToken(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [enrollOpen]);

  // Poll for new agents while enrollment modal is open
  useEffect(() => {
    if (!enrollOpen) return;
    const interval = setInterval(() => {
      fetchAgents();
    }, 5000);
    return () => clearInterval(interval);
  }, [enrollOpen, fetchAgents]);

  const startEnrollment = async () => {
    try {
      const res = await fetch("/api/enrollment");
      const data = await res.json();
      setEnrollToken(data);
      setEnrollSeconds(Math.floor((new Date(data.expiresAt).getTime() - Date.now()) / 1000));
      setEnrollOpen(true);
    } catch {
      toastError("Failed to generate enrollment token");
    }
  };

  const approveAgent = async (id: string) => {
    try {
      const res = await fetch(`/api/agents/${id}/approve`, { method: "POST" });
      if (res.ok) {
        success("Agent approved");
        fetchAgents();
      } else {
        toastError("Failed to approve agent");
      }
    } catch {
      toastError("Failed to approve agent");
    }
  };

  const rejectAgent = async (id: string) => {
    const ok = await confirm({ title: "Reject Agent", message: "Reject and delete this agent?", confirmLabel: "Reject", variant: "danger" });
    if (!ok) return;
    try {
      const res = await fetch(`/api/agents/${id}/reject`, { method: "POST" });
      if (res.ok) {
        success("Agent rejected");
        fetchAgents();
      } else {
        toastError("Failed to reject agent");
      }
    } catch {
      toastError("Failed to reject agent");
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setCreatedToken(data.token || data.api_key || null);
        fetchAgents();
        success("Agent created", "Token copied to clipboard");
      } else {
        toastError("Failed to create agent", data.error);
      }
    } catch (err) {
      toastError("Failed to create agent", "Please try again");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirm({ title: "Delete Agent", message: `Delete agent "${name}"? This cannot be undone.`, confirmLabel: "Delete", variant: "danger" });
    if (!ok) return;
    try {
      await fetch(`/api/agents/${id}`, { method: "DELETE" });
      setAgents((prev) => prev.filter((a) => a.id !== id));
      success("Agent deleted");
    } catch (err) {
      toastError("Failed to delete agent", "Please try again");
    }
  };

  // P6.4 — clear a pinned ed25519 signing pubkey so the agent re-pins on next
  // connect. Admin-only endpoint; UI only exposes this if the agent is
  // already pinned, since the alternative (unpinned) path is the default.
  const handleResetSigningKey = async (id: string, name: string) => {
    const ok = await confirm({
      title: "Reset Signing Key",
      message: `Clear the pinned ed25519 signing key for "${name}"? The agent's next register will pin a fresh key. Unsigned messages will be accepted during the grace window until that happens.`,
      confirmLabel: "Reset",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/agents/${id}/reset-signing-key`, {
        method: "POST",
      });
      if (res.ok) {
        success("Signing key reset");
        fetchAgents();
      } else {
        const data = await res.json().catch(() => ({}));
        toastError("Failed to reset signing key", data.error ?? "");
      }
    } catch {
      toastError("Failed to reset signing key", "Please try again");
    }
  };

  const handleCopy = (text: string) => {
    // Works on HTTP (non-secure) origins — execCommand fallback
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(el);
    el.focus();
    el.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    document.body.removeChild(el);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setNewName("");
    setCreatedToken(null);
    setCopied(false);
  };

  function timeAgo(dateStr?: string) {
    if (!dateStr) return "Never";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  if (loading) {
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
            Agents
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage your monitoring agents
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={startEnrollment}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-600 px-4 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
          >
            Enroll Agent
          </button>
          <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
            <Dialog.Trigger asChild>
              <button className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 transition-colors">
                <Plus className="h-4 w-4" />
                Add Agent
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
                <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
                  {createdToken ? "Agent Created" : "Add New Agent"}
                </Dialog.Title>

                {!createdToken ? (
                  <>
                    <Dialog.Description className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      Enter a name for the new agent. You will receive an API
                      token to configure the agent.
                    </Dialog.Description>
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Agent Name
                      </label>
                      <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="e.g. web-server-01"
                        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                        onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                      />
                    </div>
                    <div className="mt-6 flex justify-end gap-3">
                      <Dialog.Close asChild>
                        <button
                          onClick={closeDialog}
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                        >
                          Cancel
                        </button>
                      </Dialog.Close>
                      <button
                        onClick={handleCreate}
                        disabled={creating || !newName.trim()}
                        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {creating ? "Creating..." : "Create Agent"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-400" />
                        <p className="text-sm text-amber-800 dark:text-amber-200">
                          This token will only be shown once. Copy it now and
                          store it securely.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Agent Token
                      </label>
                      <div className="mt-1 flex items-center gap-2">
                        <code className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-900 break-all dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                          {createdToken}
                        </code>
                        <button
                          onClick={() => handleCopy(createdToken)}
                          className="rounded-lg border border-gray-300 p-2 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                        >
                          {copied ? (
                            <Check className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="mt-6 flex justify-end">
                      <button
                        onClick={closeDialog}
                        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                      >
                        Done
                      </button>
                    </div>
                  </>
                )}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {/* Pending Agents Banner */}
      {pendingAgents.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 p-4">
          <h3 className="font-semibold text-amber-800 dark:text-amber-300 mb-3">Agents Pending Approval ({pendingAgents.length})</h3>
          <div className="space-y-2">
            {pendingAgents.map(agent => (
              <div key={agent.id} className="flex items-center justify-between rounded-lg bg-white dark:bg-gray-800 p-3 border border-amber-100 dark:border-amber-800">
                <div>
                  <span className="font-medium text-gray-900 dark:text-white">{agent.name}</span>
                  <span className="ml-2 text-xs text-gray-500">{agent.ip_address} &middot; {agent.os || "unknown OS"}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => approveAgent(agent.id)} className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700">Approve</button>
                  <button onClick={() => rejectAgent(agent.id)} className="rounded-lg bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600">Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Enrollment Modal */}
      <Dialog.Root open={enrollOpen} onOpenChange={setEnrollOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
              Enroll New Agent
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Use this token on the agent machine to enroll it with the hub.
            </Dialog.Description>

            {enrollToken && (
              <div className="mt-4 space-y-4">
                <div className="text-center">
                  <code className="text-2xl font-mono bg-amber-100 dark:bg-amber-900 px-4 py-2 rounded-lg tracking-widest">{enrollToken.token}</code>
                </div>

                <div className="text-center text-sm text-gray-500 dark:text-gray-400">
                  Expires in {Math.floor(enrollSeconds / 60)}:{String(enrollSeconds % 60).padStart(2, "0")}
                </div>

                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Run on the agent machine:</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm font-mono text-gray-900 dark:text-white break-all">
                      vigil-agent --enroll {enrollToken.token} --hub-url {hubUrl}
                    </code>
                    <button
                      onClick={() => handleCopy(`vigil-agent --enroll ${enrollToken.token} --hub-url ${hubUrl}`)}
                      className="rounded-lg border border-gray-300 p-2 text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-sm">
                  {pendingAgents.length > 0 ? (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">Agent connected! Check pending agents above.</span>
                  ) : (
                    <span className="text-gray-500 dark:text-gray-400 animate-pulse">Waiting for agent...</span>
                  )}
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <Dialog.Close asChild>
                <button className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                  Close
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Agent Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {agents.length > 0 ? (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Name
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  OS
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Version
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Last Seen
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Checks
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Signed
                </th>
                <th className="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {agents.map((agent) => (
                <tr
                  key={agent.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Server className="h-4 w-4 text-gray-400" />
                      <span className="font-medium text-gray-900 dark:text-white">
                        {agent.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                        agent.status === "online"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                          : agent.status === "pending"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                          : agent.status === "offline"
                          ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                          : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400"
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          agent.status === "online"
                            ? "bg-emerald-500"
                            : agent.status === "pending"
                            ? "bg-amber-500"
                            : agent.status === "offline"
                            ? "bg-red-500"
                            : "bg-gray-400"
                        )}
                      />
                      {agent.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {agent.os || "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {agent.version || "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {timeAgo(agent.last_seen)}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {agent.check_count ?? 0}
                  </td>
                  <td className="px-4 py-3">
                    {agent.result_signing_pinned ? (
                      <span
                        className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
                        title={
                          agent.result_signing_pubkey_prefix
                            ? `Pinned ed25519 key ${agent.result_signing_pubkey_prefix}…`
                            : "Signed"
                        }
                      >
                        <ShieldCheck className="h-4 w-4" />
                        <span className="text-xs font-medium">Yes</span>
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 text-gray-400 dark:text-gray-500"
                        title="No signing key pinned — legacy or pre-grace agent"
                      >
                        <ShieldOff className="h-4 w-4" />
                        <span className="text-xs">—</span>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <a
                        href={`/agents/${agent.id}`}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                        title="View details"
                      >
                        <Eye className="h-4 w-4" />
                      </a>
                      {agent.result_signing_pinned && (
                        <button
                          onClick={() =>
                            handleResetSigningKey(agent.id, agent.name)
                          }
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950 dark:hover:text-amber-400"
                          title="Reset agent signing key"
                        >
                          <KeyRound className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(agent.id, agent.name)}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
                        title="Delete agent"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="p-12 text-center">
            <Server className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
            <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-white">
              No agents
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Get started by adding your first monitoring agent.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
