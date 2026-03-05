"use client";

import { useEffect, useState } from "react";
import { Plus, Activity, ClipboardCheck, Pencil, Trash2 } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast-provider";

interface CheckRecord {
  id: string;
  agent_id: string;
  agent_name?: string;
  name: string;
  type: string;
  status: string;
  last_checked?: string;
  latency_ms?: number;
  config?: string;
  interval_seconds?: number;
}

interface Agent {
  id: string;
  name: string;
}

export default function ChecksPage() {
  const [checks, setChecks] = useState<CheckRecord[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editCheck, setEditCheck] = useState<CheckRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [editInterval, setEditInterval] = useState("60");
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [filter, setFilter] = useState("all");

  // Form state
  const [formAgent, setFormAgent] = useState("");
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState("http");
  const [formInterval, setFormInterval] = useState("60");

  // Dynamic config fields per type
  const [cfgUrl, setCfgUrl] = useState("https://");
  const [cfgExpectedStatus, setCfgExpectedStatus] = useState("200");
  const [cfgHost, setCfgHost] = useState("");
  const [cfgPort, setCfgPort] = useState("443");
  const [cfgTimeoutMs, setCfgTimeoutMs] = useState("5000");
  const [cfgServiceName, setCfgServiceName] = useState("");
  const [cfgWarnDays, setCfgWarnDays] = useState("30");
  const [cfgCpuAlert, setCfgCpuAlert] = useState("90");
  const [cfgRamAlert, setCfgRamAlert] = useState("85");
  const [cfgDiskAlert, setCfgDiskAlert] = useState("90");
  const [cfgBodyKeyword, setCfgBodyKeyword] = useState("");

  const buildConfig = () => {
    switch (formType) {
      case "http": return { url: cfgUrl, expected_status: parseInt(cfgExpectedStatus), timeout_ms: parseInt(cfgTimeoutMs), ...(cfgBodyKeyword ? { body_keyword: cfgBodyKeyword } : {}) };
      case "port": return { host: cfgHost, port: parseInt(cfgPort), timeout_ms: parseInt(cfgTimeoutMs) };
      case "ping": return { host: cfgHost };
      case "service": return { name: cfgServiceName };
      case "cert": return { host: cfgHost, port: parseInt(cfgPort), warn_days: parseInt(cfgWarnDays) };
      case "resource": return { cpu_alert_pct: parseFloat(cfgCpuAlert), ram_alert_pct: parseFloat(cfgRamAlert), disk_alert_pct: parseFloat(cfgDiskAlert) };
      default: return {};
    }
  };

  const resetConfigFields = () => {
    setCfgUrl("https://"); setCfgExpectedStatus("200"); setCfgHost("");
    setCfgPort("443"); setCfgTimeoutMs("5000"); setCfgServiceName("");
    setCfgWarnDays("30"); setCfgCpuAlert("90"); setCfgRamAlert("85");
    setCfgDiskAlert("90"); setCfgBodyKeyword("");
  };
  const [creating, setCreating] = useState(false);
  const { success: toastSuccess, error: toastError, confirm: showConfirm } = useToast();

  const fetchData = async () => {
    try {
      const [checksRes, agentsRes] = await Promise.all([
        fetch("/api/checks")
          .then((r) => r.json())
          .catch(() => []),
        fetch("/api/agents")
          .then((r) => r.json())
          .catch(() => []),
      ]);
      setChecks(Array.isArray(checksRes) ? checksRes : []);
      setAgents(Array.isArray(agentsRes) ? agentsRes : []);
    } catch (err) {
      console.error("Failed to fetch checks:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Live check results via SSE
  useEffect(() => {
    const es = new EventSource("/api/sse");
    es.addEventListener("check_result", (e) => {
      try {
        const result = JSON.parse(e.data);
        setChecks((prev) =>
          prev.map((c) =>
            c.id === result.checkId
              ? { ...c, status: result.status, lastChecked: result.timestamp }
              : c
          )
        );
      } catch {}
    });
    return () => es.close();
  }, []);

  const handleDelete = async (id: string, name: string) => {
    const confirmed = await showConfirm(`Delete check "${name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/checks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setChecks((prev) => prev.filter((c) => c.id !== id));
      toastSuccess(`Check "${name}" deleted`);
    } catch {
      toastError("Failed to delete check");
    }
  };

  const openEdit = (check: CheckRecord) => {
    setEditCheck(check);
    setEditName(check.name);
    setEditInterval(String(check.interval_seconds ?? 60));
    setEditDialogOpen(true);
  };

  const handleEditSave = async () => {
    if (!editCheck) return;
    try {
      const res = await fetch(`/api/checks/${editCheck.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, intervalSecs: parseInt(editInterval) }),
      });
      if (!res.ok) throw new Error("Failed");
      setChecks((prev) =>
        prev.map((c) => c.id === editCheck.id ? { ...c, name: editName, interval_seconds: parseInt(editInterval) } : c)
      );
      setEditDialogOpen(false);
      toastSuccess("Check updated");
    } catch {
      toastError("Failed to update check");
    }
  };

  const filteredChecks = checks.filter((c) => {
    if (filter === "all") return true;
    if (filter === "ok") return c.status === "ok";
    if (filter === "warning") return c.status === "warning";
    if (filter === "critical") return c.status === "critical";
    return true;
  });

  const handleCreate = async () => {
    if (!formAgent || !formName.trim()) return;
    setCreating(true);
    try {
      const parsedConfig = buildConfig();

      const res = await fetch("/api/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: formAgent,
          name: formName.trim(),
          type: formType,
          config: parsedConfig,
          interval_seconds: parseInt(formInterval, 10) || 60,
        }),
      });

      if (res.ok) {
        setDialogOpen(false);
        setFormAgent("");
        setFormName("");
        setFormType("http");
        setFormInterval("60");
        resetConfigFields();
        fetchData();
        success("Check created successfully");
      } else {
        const data = await res.json();
        toastError("Failed to create check", data.error);
      }
    } catch {
      toastError("Failed to create check", "Please try again");
    } finally {
      setCreating(false);
    }
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
    <>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:flex-nowrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Checks
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Monitor health checks across all agents
          </p>
        </div>
        <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
          <Dialog.Trigger asChild>
            <button className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 transition-colors">
              <Plus className="h-4 w-4" />
              Add Check
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
              <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
                Add New Check
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Configure a new health check for an agent.
              </Dialog.Description>

              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Agent
                  </label>
                  <select
                    value={formAgent}
                    onChange={(e) => setFormAgent(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  >
                    <option value="">Select an agent...</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Check Name
                  </label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g. Homepage HTTP"
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Type
                  </label>
                  <select
                    value={formType}
                    onChange={(e) => setFormType(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  >
                    <option value="http">HTTP</option>
                    <option value="port">Port / TCP</option>
                    <option value="ping">Ping</option>
                    <option value="service">Service</option>
                    <option value="cert">SSL Certificate</option>
                    <option value="resource">Resource (CPU/RAM/Disk)</option>
                  </select>
                </div>

                {/* Dynamic config fields per check type */}
                <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Configuration</p>

                  {/* HTTP */}
                  {formType === "http" && <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">URL</label>
                      <input type="url" value={cfgUrl} onChange={e => setCfgUrl(e.target.value)} placeholder="https://example.com" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Expected Status</label>
                        <input type="number" value={cfgExpectedStatus} onChange={e => setCfgExpectedStatus(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Timeout (ms)</label>
                        <input type="number" value={cfgTimeoutMs} onChange={e => setCfgTimeoutMs(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Body Keyword <span className="font-normal text-gray-400">(optional)</span></label>
                      <input type="text" value={cfgBodyKeyword} onChange={e => setCfgBodyKeyword(e.target.value)} placeholder="e.g. OK or healthy" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                    </div>
                  </>}

                  {/* Port */}
                  {formType === "port" && <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Host</label>
                      <input type="text" value={cfgHost} onChange={e => setCfgHost(e.target.value)} placeholder="192.168.1.1 or hostname" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Port</label>
                        <input type="number" value={cfgPort} onChange={e => setCfgPort(e.target.value)} placeholder="443" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Timeout (ms)</label>
                        <input type="number" value={cfgTimeoutMs} onChange={e => setCfgTimeoutMs(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                    </div>
                  </>}

                  {/* Ping */}
                  {formType === "ping" && <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Host / IP</label>
                    <input type="text" value={cfgHost} onChange={e => setCfgHost(e.target.value)} placeholder="192.168.1.1 or hostname" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                  </div>}

                  {/* Service */}
                  {formType === "service" && <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Service Name</label>
                    <input type="text" value={cfgServiceName} onChange={e => setCfgServiceName(e.target.value)} placeholder="Windows: Spooler  |  Linux: nginx.service" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                    <p className="mt-1 text-xs text-gray-400">Use the exact service name (Windows) or unit name (Linux)</p>
                  </div>}

                  {/* Certificate */}
                  {formType === "cert" && <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Domain</label>
                      <input type="text" value={cfgHost} onChange={e => setCfgHost(e.target.value)} placeholder="example.com" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Port</label>
                        <input type="number" value={cfgPort} onChange={e => setCfgPort(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Warn if expiring within (days)</label>
                        <input type="number" value={cfgWarnDays} onChange={e => setCfgWarnDays(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                    </div>
                  </>}

                  {/* Resource */}
                  {formType === "resource" && <>
                    <p className="text-xs text-gray-500">Alert thresholds — trigger warning when exceeded</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">CPU %</label>
                        <input type="number" value={cfgCpuAlert} onChange={e => setCfgCpuAlert(e.target.value)} min="1" max="100" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">RAM %</label>
                        <input type="number" value={cfgRamAlert} onChange={e => setCfgRamAlert(e.target.value)} min="1" max="100" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Disk %</label>
                        <input type="number" value={cfgDiskAlert} onChange={e => setCfgDiskAlert(e.target.value)} min="1" max="100" className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                      </div>
                    </div>
                  </>}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Interval (seconds)
                  </label>
                  <input
                    type="number"
                    value={formInterval}
                    onChange={(e) => setFormInterval(e.target.value)}
                    min="10"
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <Dialog.Close asChild>
                  <button className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  onClick={handleCreate}
                  disabled={creating || !formAgent || !formName.trim()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create Check"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>

      {/* Filter Tabs */}
      <Tabs.Root value={filter} onValueChange={setFilter}>
        <Tabs.List className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
          {[
            { value: "all", label: "All" },
            { value: "ok", label: "OK" },
            { value: "warning", label: "Warning" },
            { value: "critical", label: "Critical" },
          ].map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                filter === tab.value
                  ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              )}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      {/* Checks Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {filteredChecks.length > 0 ? (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Agent
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Check Name
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Type
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Last Checked
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Latency
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {filteredChecks.map((check) => (
                <tr
                  key={check.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="px-4 py-3 text-gray-900 dark:text-white">
                    {check.agent_name || check.agent_id}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                    {check.name}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                      {check.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                        check.status === "ok"
                          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                          : check.status === "warning"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                          : check.status === "critical"
                          ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                          : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400"
                      )}
                    >
                      {check.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {timeAgo(check.last_checked)}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {check.latency_ms != null ? `${check.latency_ms}ms` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEdit(check)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700 dark:hover:text-blue-400 transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(check.id, check.name)}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400 transition-colors"
                        title="Delete"
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
            <ClipboardCheck className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
            <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-white">
              No checks found
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {filter !== "all"
                ? "No checks match the current filter."
                : "Add your first health check to start monitoring."}
            </p>
          </div>
        )}
      </div>
    </div>

    {/* Edit Check Dialog */}
    <Dialog.Root open={editDialogOpen} onOpenChange={setEditDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900">
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Edit Check
          </Dialog.Title>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Check Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Interval (seconds)</label>
              <input
                type="number"
                value={editInterval}
                onChange={(e) => setEditInterval(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => setEditDialogOpen(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={handleEditSave}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    </>
  );
}
