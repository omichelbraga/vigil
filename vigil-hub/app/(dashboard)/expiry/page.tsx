"use client";

import { useEffect, useState } from "react";
import { Plus, Activity, KeyRound, Shield, Calendar, RefreshCw, Pencil, Trash2 } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { statusLabel, statusColor } from "@/lib/status";
import { useToast } from "@/components/ui/toast-provider";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface ExpiryMonitor {
  id: string;
  name: string;
  description?: string;
  expiresAt: string;
  warnDays: number;
  category: string;
  status: string;
  daysRemaining: number;
  lastChecked?: string;
}

const CATEGORIES = [
  { value: "azure_secret", label: "Azure App Secret", icon: "🔑" },
  { value: "saml_cert", label: "SAML Certificate", icon: "🛡️" },
  { value: "other", label: "Other", icon: "📅" },
];

function categoryLabel(cat: string) {
  return CATEGORIES.find((c) => c.value === cat) ?? { label: cat, icon: "📅" };
}

function daysColor(days: number, warnDays: number) {
  if (days <= 0) return "text-red-600 dark:text-red-400 font-bold";
  if (days <= warnDays) return "text-amber-600 dark:text-amber-400 font-medium";
  return "text-green-600 dark:text-green-400";
}

export default function ExpiryPage() {
  const [monitors, setMonitors] = useState<ExpiryMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editMonitor, setEditMonitor] = useState<ExpiryMonitor | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formCategory, setFormCategory] = useState("azure_secret");
  const [formExpiresAt, setFormExpiresAt] = useState("");
  const [formWarnDays, setFormWarnDays] = useState("30");

  // Edit state
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [editWarnDays, setEditWarnDays] = useState("30");
  const [editCategory, setEditCategory] = useState("other");

  const { success: toastSuccess, error: toastError } = useToast();
  const showConfirm = useConfirm();

  const fetchMonitors = async () => {
    try {
      const res = await fetch("/api/expiry-monitors");
      const data = await res.json();
      setMonitors(Array.isArray(data) ? data : []);
    } catch {
      toastError("Failed to load expiry monitors");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchMonitors(); }, []);

  const handleAdd = async () => {
    if (!formName || !formExpiresAt) { toastError("Name and expiry date required"); return; }
    try {
      const res = await fetch("/api/expiry-monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: formName, description: formDesc, category: formCategory, expiresAt: formExpiresAt, warnDays: parseInt(formWarnDays) }),
      });
      if (!res.ok) throw new Error("Failed");
      const m = await res.json();
      setMonitors((prev) => [...prev, m].sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()));
      setDialogOpen(false);
      setFormName(""); setFormDesc(""); setFormExpiresAt(""); setFormWarnDays("30"); setFormCategory("azure_secret");
      toastSuccess("Monitor added");
    } catch { toastError("Failed to add monitor"); }
  };

  const handleDelete = async (id: string, name: string) => {
    const confirmed = await showConfirm({
      title: "Delete Monitor",
      message: `Delete "${name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await fetch(`/api/expiry-monitors/${id}`, { method: "DELETE" });
      setMonitors((prev) => prev.filter((m) => m.id !== id));
      toastSuccess(`"${name}" deleted`);
    } catch { toastError("Failed to delete"); }
  };

  const openEdit = (m: ExpiryMonitor) => {
    setEditMonitor(m);
    setEditName(m.name);
    setEditDesc(m.description || "");
    setEditExpiresAt(new Date(m.expiresAt).toISOString().split("T")[0]);
    setEditWarnDays(String(m.warnDays));
    setEditCategory(m.category);
    setEditDialogOpen(true);
  };

  const handleEditSave = async () => {
    if (!editMonitor) return;
    try {
      const res = await fetch(`/api/expiry-monitors/${editMonitor.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, description: editDesc, expiresAt: editExpiresAt, warnDays: parseInt(editWarnDays), category: editCategory }),
      });
      if (!res.ok) throw new Error("Failed");
      setEditDialogOpen(false);
      fetchMonitors();
      toastSuccess("Monitor updated");
    } catch { toastError("Failed to update"); }
  };

  const handleCheckNow = async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/expiry-monitors/check", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
      fetchMonitors();
      toastSuccess("Checks complete");
    } catch { toastError("Check failed"); }
    finally { setChecking(false); }
  };

  const critical = monitors.filter((m) => m.status === "critical").length;
  const warning = monitors.filter((m) => m.status === "warning").length;

  if (loading) {
    return <div className="flex h-96 items-center justify-center"><Activity className="h-8 w-8 animate-spin text-gray-400" /></div>;
  }

  return (
    <>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Expiry Monitors</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Track Azure App Secrets, SAML certificates, and other expiring credentials</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleCheckNow}
            disabled={checking}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} />
            Check Now
          </button>
          <button
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <Plus className="h-4 w-4" />
            Add Monitor
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {monitors.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <p className="text-sm text-gray-500 dark:text-gray-400">Total Monitors</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{monitors.length}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
            <p className="text-sm text-amber-700 dark:text-amber-400">Expiring Soon</p>
            <p className="mt-1 text-2xl font-bold text-amber-700 dark:text-amber-400">{warning}</p>
          </div>
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
            <p className="text-sm text-red-700 dark:text-red-400">Expired</p>
            <p className="mt-1 text-2xl font-bold text-red-700 dark:text-red-400">{critical}</p>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {monitors.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Category</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Expiry Date</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Days Remaining</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {monitors.map((m) => {
                  const cat = categoryLabel(m.category);
                  return (
                    <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 dark:text-white">{m.name}</div>
                        {m.description && <div className="text-xs text-gray-400 mt-0.5">{m.description}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                          {cat.icon} {cat.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {new Date(m.expiresAt).toLocaleDateString()}
                      </td>
                      <td className={cn("px-4 py-3", daysColor(m.daysRemaining, m.warnDays))}>
                        {m.daysRemaining <= 0 ? `Expired ${Math.abs(m.daysRemaining)}d ago` : `${m.daysRemaining} days`}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", statusColor(m.status))}>
                          {statusLabel(m.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button onClick={() => openEdit(m)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700" title="Edit">
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button onClick={() => handleDelete(m.id, m.name)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950" title="Delete">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-12 text-center">
            <KeyRound className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
            <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-white">No expiry monitors yet</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Add Azure App Secrets or SAML certificates to track their expiration dates.</p>
            <button onClick={() => setDialogOpen(true)} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              <Plus className="h-4 w-4" /> Add Monitor
            </button>
          </div>
        )}
      </div>
    </div>

    {/* Add Dialog */}
    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900">
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Add Expiry Monitor</Dialog.Title>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select value={formCategory} onChange={(e) => setFormCategory(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.icon} {c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
              <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Intuneget App Secret"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description (optional)</label>
              <input type="text" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="App Registration ID or notes"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Expiration Date</label>
              <input type="date" value={formExpiresAt} onChange={(e) => setFormExpiresAt(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Warn Days Before Expiry</label>
              <input type="number" value={formWarnDays} onChange={(e) => setFormWarnDays(e.target.value)} min="1" max="365"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button onClick={() => setDialogOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
            <button onClick={handleAdd} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">Add Monitor</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    {/* Edit Dialog */}
    <Dialog.Root open={editDialogOpen} onOpenChange={setEditDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900">
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Edit Monitor</Dialog.Title>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.icon} {c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
              <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Expiration Date</label>
              <input type="date" value={editExpiresAt} onChange={(e) => setEditExpiresAt(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Warn Days</label>
              <input type="number" value={editWarnDays} onChange={(e) => setEditWarnDays(e.target.value)} min="1" max="365"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button onClick={() => setEditDialogOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
            <button onClick={handleEditSave} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">Save</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    </>
  );
}
