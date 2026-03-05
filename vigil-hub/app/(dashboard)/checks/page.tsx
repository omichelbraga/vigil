"use client";

import { useEffect, useState } from "react";
import { Plus, Activity, ClipboardCheck } from "lucide-react";
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
  const [filter, setFilter] = useState("all");

  // Form state
  const [formAgent, setFormAgent] = useState("");
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState("http");
  const [formConfig, setFormConfig] = useState("{}");
  const [formInterval, setFormInterval] = useState("60");
  const [creating, setCreating] = useState(false);
  const { success, error: toastError } = useToast();

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
      let parsedConfig = {};
      try {
        parsedConfig = JSON.parse(formConfig);
      } catch {
        toastError("Invalid JSON", "Check the config field and try again");
        setCreating(false);
        return;
      }

      const res = await fetch("/api/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: formAgent,
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
        setFormConfig("{}");
        setFormInterval("60");
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
                    <option value="tcp">TCP</option>
                    <option value="dns">DNS</option>
                    <option value="ping">Ping</option>
                    <option value="ssl">SSL Certificate</option>
                    <option value="command">Command</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Config (JSON)
                  </label>
                  <textarea
                    value={formConfig}
                    onChange={(e) => setFormConfig(e.target.value)}
                    rows={4}
                    placeholder='{"url": "https://example.com", "expected_status": 200}'
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                  />
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
  );
}
