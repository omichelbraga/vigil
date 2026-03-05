"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Server,
  Clock,
  Monitor,
  Globe,
  Activity,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import { statusLabel, statusColor } from "@/lib/status";

interface Agent {
  id: string;
  name: string;
  status: string;
  os?: string;
  version?: string;
  hostname?: string;
  ip_address?: string;
  last_seen?: string;
}

interface CheckItem {
  id: string;
  name: string;
  type: string;
  status: string;
  last_result?: string;
  latency_ms?: number;
}

interface ResultItem {
  id: string;
  check_name: string;
  status: string;
  latency_ms?: number;
  created_at: string;
  message?: string;
}

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [agentRes, resultsRes] = await Promise.all([
          fetch(`/api/agents/${agentId}`).then((r) => r.json()),
          fetch(`/api/results?agent_id=${agentId}&limit=200`)
            .then((r) => r.json())
            .catch(() => []),
        ]);

        if (agentRes && !agentRes.error) {
          setAgent(agentRes);
          setChecks(agentRes.checks || []);
        }
        setResults(Array.isArray(resultsRes) ? resultsRes : []);
      } catch (err) {
        console.error("Failed to fetch agent data:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [agentId]);

  const chartData = results
    .filter((r) => r.latency_ms !== undefined && r.latency_ms !== null)
    .map((r) => ({
      time: new Date(r.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      latency: r.latency_ms,
      status: r.status,
    }))
    .reverse()
    .slice(-50);

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

  if (!agent) {
    return (
      <div className="flex h-96 flex-col items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">Agent not found.</p>
        <a
          href="/agents"
          className="mt-3 text-sm font-medium text-emerald-600 hover:text-emerald-500"
        >
          Back to agents
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <a
        href="/agents"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Agents
      </a>

      {/* Agent Header */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800">
              <Server className="h-6 w-6 text-gray-600 dark:text-gray-400" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                  {agent.name}
                </h1>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                    agent.status === "online"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
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
                        : agent.status === "offline"
                        ? "bg-red-500"
                        : "bg-gray-400"
                    )}
                  />
                  {statusLabel(agent.status)}
                </span>
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {agent.hostname || "Unknown host"}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="flex items-center gap-2 text-sm">
            <Monitor className="h-4 w-4 text-gray-400" />
            <span className="text-gray-500 dark:text-gray-400">OS:</span>
            <span className="font-medium text-gray-900 dark:text-white">
              {agent.os || "—"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-gray-400" />
            <span className="text-gray-500 dark:text-gray-400">Version:</span>
            <span className="font-medium text-gray-900 dark:text-white">
              {agent.version || "—"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Globe className="h-4 w-4 text-gray-400" />
            <span className="text-gray-500 dark:text-gray-400">IP:</span>
            <span className="font-medium text-gray-900 dark:text-white">
              {agent.ip_address || "—"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-gray-400" />
            <span className="text-gray-500 dark:text-gray-400">
              Last Seen:
            </span>
            <span className="font-medium text-gray-900 dark:text-white">
              {timeAgo(agent.last_seen)}
            </span>
          </div>
        </div>
      </div>

      {/* Response Time Chart */}
      {chartData.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            Response Time (ms)
          </h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#e5e7eb"
                className="dark:stroke-gray-700"
              />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 12 }}
                stroke="#9ca3af"
              />
              <YAxis tick={{ fontSize: 12 }} stroke="#9ca3af" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: "8px",
                  color: "#f9fafb",
                }}
              />
              <Line
                type="monotone"
                dataKey="latency"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "#10b981" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Checks Table */}
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Checks
          </h2>
        </div>
        {checks.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Name
                </th>
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Type
                </th>
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Last Result
                </th>
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Latency
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {checks.map((check) => (
                <tr key={check.id}>
                  <td className="px-6 py-3 font-medium text-gray-900 dark:text-white">
                    {check.name}
                  </td>
                  <td className="px-6 py-3 text-gray-500 dark:text-gray-400">
                    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium dark:bg-gray-800">
                      {check.type}
                    </span>
                  </td>
                  <td className="px-6 py-3">
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
                      {statusLabel(check.status)}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-500 dark:text-gray-400">
                    {check.last_result || "—"}
                  </td>
                  <td className="px-6 py-3 text-gray-500 dark:text-gray-400">
                    {check.latency_ms != null ? `${check.latency_ms}ms` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No checks configured for this agent yet.
          </div>
        )}
      </div>

      {/* Recent Results Table */}
      {results.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Recent Results
            </h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Check
                </th>
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Latency
                </th>
                <th className="px-6 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Time
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {results.slice(0, 20).map((result) => (
                <tr key={result.id}>
                  <td className="px-6 py-3 font-medium text-gray-900 dark:text-white">
                    {result.check_name}
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                        result.status === "ok"
                          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                          : result.status === "warning"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                          : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                      )}
                    >
                      {statusLabel(result.status)}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-500 dark:text-gray-400">
                    {result.latency_ms != null
                      ? `${result.latency_ms}ms`
                      : "—"}
                  </td>
                  <td className="px-6 py-3 text-gray-500 dark:text-gray-400">
                    {timeAgo(result.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
