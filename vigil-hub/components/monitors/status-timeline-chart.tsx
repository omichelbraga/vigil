"use client";

import { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { cn } from "@/lib/utils";

interface TimelineSample {
  timestamp: string;
  status: string;
}

interface StatusTimelineChartProps {
  samples: TimelineSample[];
  height?: number;
}

type Range = "24h" | "7d" | "30d";

interface Bucket {
  label: string;
  ts: number;
  ok: number;
  warning: number;
  critical: number;
  unknown: number;
}

const COLORS = {
  ok: "#10b981",
  warning: "#f59e0b",
  critical: "#ef4444",
  unknown: "#9ca3af",
};

function canonicalStatus(s: string): "ok" | "warning" | "critical" | "unknown" {
  switch (s?.toLowerCase()) {
    case "ok":
      return "ok";
    case "warning":
    case "warn":
      return "warning";
    case "critical":
    case "offline":
      return "critical";
    default:
      return "unknown";
  }
}

function bucketize(samples: TimelineSample[], range: Range): Bucket[] {
  const now = Date.now();
  let windowMs: number;
  let bucketMs: number;
  let fmt: Intl.DateTimeFormatOptions;
  switch (range) {
    case "24h":
      windowMs = 24 * 3_600_000;
      bucketMs = 5 * 60_000; // 5-min buckets
      fmt = { hour: "2-digit", minute: "2-digit" };
      break;
    case "7d":
      windowMs = 7 * 24 * 3_600_000;
      bucketMs = 60 * 60_000; // hourly
      fmt = { month: "short", day: "2-digit", hour: "2-digit" };
      break;
    case "30d":
    default:
      windowMs = 30 * 24 * 3_600_000;
      bucketMs = 6 * 60 * 60_000; // 6h
      fmt = { month: "short", day: "2-digit" };
      break;
  }

  const bucketCount = Math.ceil(windowMs / bucketMs);
  const start = now - bucketCount * bucketMs;
  const buckets: Bucket[] = [];
  const fmtter = new Intl.DateTimeFormat(undefined, fmt);
  for (let i = 0; i < bucketCount; i += 1) {
    const ts = start + i * bucketMs;
    buckets.push({
      label: fmtter.format(new Date(ts)),
      ts,
      ok: 0,
      warning: 0,
      critical: 0,
      unknown: 0,
    });
  }

  for (const s of samples) {
    const t = new Date(s.timestamp).getTime();
    if (Number.isNaN(t) || t < start || t > now) continue;
    const idx = Math.floor((t - start) / bucketMs);
    const safeIdx = Math.min(Math.max(0, idx), bucketCount - 1);
    buckets[safeIdx][canonicalStatus(s.status)] += 1;
  }

  return buckets;
}

export function StatusTimelineChart({
  samples,
  height = 180,
}: StatusTimelineChartProps): React.ReactElement {
  const [range, setRange] = useState<Range>("24h");
  const data = useMemo(() => bucketize(samples, range), [samples, range]);
  const hasData = data.some((b) => b.ok + b.warning + b.critical + b.unknown > 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Status timeline
        </p>
        <div className="flex gap-1 rounded-md bg-gray-100 p-0.5 dark:bg-gray-800">
          {(["24h", "7d", "30d"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
                range === r
                  ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {hasData ? (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "#6b7280" }}
                axisLine={false}
                tickLine={false}
                interval={Math.max(0, Math.floor(data.length / 6) - 1)}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#6b7280" }}
                axisLine={false}
                tickLine={false}
                width={28}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  padding: "4px 8px",
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                dataKey="ok"
                stackId="1"
                stroke={COLORS.ok}
                fill={COLORS.ok}
                fillOpacity={0.7}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="warning"
                stackId="1"
                stroke={COLORS.warning}
                fill={COLORS.warning}
                fillOpacity={0.7}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="critical"
                stackId="1"
                stroke={COLORS.critical}
                fill={COLORS.critical}
                fillOpacity={0.8}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="unknown"
                stackId="1"
                stroke={COLORS.unknown}
                fill={COLORS.unknown}
                fillOpacity={0.5}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-gray-200 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
          style={{ height }}
        >
          No check results in this window
        </div>
      )}
    </div>
  );
}
