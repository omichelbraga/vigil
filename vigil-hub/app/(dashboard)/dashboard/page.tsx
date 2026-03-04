"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Server,
  CheckCircle2,
  XCircle,
  Shield,
  Activity,
  Wifi,
  WifiOff,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Agent {
  id: string;
  name: string;
  status: string;
  os?: string;
  version?: string;
  hostname?: string;
  last_seen?: string;
  check_count?: number;
}

interface AlertRecord {
  id: string;
  check_name?: string;
  agent_name?: string;
  status: string;
  channel?: string;
  delivered?: boolean;
  created_at: string;
  message?: string;
}

interface CertRecord {
  id: string;
  domain: string;
  expiry_date?: string;
  days_remaining?: number;
}

interface CheckResult {
  id: string;
  agent_id: string;
  check_name: string;
  status: string;
  latency_ms?: number;
  created_at: string;
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [certs, setCerts] = useState<CertRecord[]>([]);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [agentsRes, alertsRes, certsRes, resultsRes] = await Promise.all([
        fetch("/api/agents").then((r) => r.json()),
        fetch("/api/alerts?limit=10")
          .then((r) => r.json())
          .catch(() => []),
        fetch("/api/certs")
          .then((r) => r.json())
          .catch(() => []),
        fetch("/api/results?limit=50")
          .then((r) => r.json())
          .catch(() => []),
      ]);
      setAgents(Array.isArray(agentsRes) ? agentsRes : []);
      setAlerts(Array.isArray(alertsRes) ? alertsRes : []);
      setCerts(Array.isArray(certsRes) ? certsRes : []);
      setResults(Array.isArray(resultsRes) ? resultsRes : []);
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // SSE for real-time updates
  useEffect(() => {
    const es = new EventSource("/api/sse");
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "agent_status") {
          setAgents((prev) =>
            prev.map((a) =>
              a.id === data.agent_id
                ? { ...a, status: data.status, last_seen: data.last_seen }
                : a
            )
          );
        } else if (data.type === "check_result") {
          setResults((prev) => [data.result, ...prev].slice(0, 50));
        } else if (data.type === "alert") {
          setAlerts((prev) => [data.alert, ...prev].slice(0, 10));
        }
      } catch {
        // ignore parse errors
      }
    };
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
  }, []);

  const totalAgents = agents.length;
  const onlineAgents = agents.filter((a) => a.status === "online").length;
  const passingChecks = results.filter((r) => r.status === "ok").length;
  const failingChecks = results.filter(
    (r) => r.status === "critical" || r.status === "warning"
  ).length;
  const certsExpiring = certs.filter(
    (c) => c.days_remaining !== undefined && c.days_remaining <= 30
  ).length;

  const summaryCards = [
    {
      label: "Total Agents",
      value: totalAgents,
      icon: Server,
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-50 dark:bg-blue-950",
    },
    {
      label: "Online Agents",
      value: onlineAgents,
      icon: Wifi,
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-50 dark:bg-emerald-950",
    },
    {
      label: "Checks Passing",
      value: passingChecks,
      icon: CheckCircle2,
      color: "text-green-600 dark:text-green-400",
      bg: "bg-green-50 dark:bg-green-950",
    },
    {
      label: "Checks Failing",
      value: failingChecks,
      icon: XCircle,
      color: "text-red-600 dark:text-red-400",
      bg: "bg-red-50 dark:bg-red-950",
    },
    {
      label: "Certs Expiring Soon",
      value: certsExpiring,
      icon: Shield,
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-50 dark:bg-amber-950",
    },
  ];

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
      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {summaryCards.map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                {card.label}
              </span>
              <div className={cn("rounded-lg p-2", card.bg)}>
                <card.icon className={cn("h-5 w-5", card.color)} />
              </div>
            </div>
            <p className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
              {card.value}
            </p>
          </div>
        ))}
      </div>

      {/* Agent Status Grid */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Agent Status
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {agents.map((agent) => (
            <a
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="rounded-xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "h-3 w-3 rounded-full",
                    agent.status === "online"
                      ? "bg-emerald-500"
                      : agent.status === "offline"
                      ? "bg-red-500"
                      : "bg-gray-400"
                  )}
                />
                <span className="font-medium text-gray-900 dark:text-white">
                  {agent.name}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  {timeAgo(agent.last_seen)}
                </span>
                <span>
                  {agent.check_count ?? 0} check
                  {agent.check_count !== 1 ? "s" : ""}
                </span>
              </div>
            </a>
          ))}
          {agents.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
              <WifiOff className="mx-auto h-10 w-10 text-gray-400" />
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                No agents registered yet.
              </p>
              <a
                href="/agents"
                className="mt-3 inline-block text-sm font-medium text-emerald-600 hover:text-emerald-500"
              >
                Add your first agent
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Recent Alerts */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Recent Alerts
        </h2>
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          {alerts.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Check
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Agent
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Channel
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {alerts.map((alert) => (
                  <tr key={alert.id}>
                    <td className="px-4 py-3 text-gray-900 dark:text-white">
                      {alert.check_name || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                      {alert.agent_name || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          alert.status === "critical"
                            ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                            : alert.status === "warning"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                            : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                        )}
                      >
                        {alert.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                      {alert.channel || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                      {timeAgo(alert.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
              No alerts yet. Alerts will appear here when checks fail.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
