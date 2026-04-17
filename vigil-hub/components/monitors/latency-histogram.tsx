"use client";

import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

interface HistogramSample {
  responseTimeMs: number;
}

interface LatencyHistogramProps {
  samples: HistogramSample[];
  bucketCount?: number;
  height?: number;
}

interface Bucket {
  range: string;
  low: number;
  high: number;
  count: number;
}

/** Build equal-width histogram buckets over min..max (with a tiny pad for equal values). */
function buildBuckets(values: number[], bucketCount: number): Bucket[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = span / bucketCount;
  const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    range: `${Math.round(min + i * step)}-${Math.round(min + (i + 1) * step)}ms`,
    low: min + i * step,
    high: min + (i + 1) * step,
    count: 0,
  }));
  for (const v of values) {
    let idx = Math.floor((v - min) / step);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count += 1;
  }
  return buckets;
}

export function LatencyHistogram({
  samples,
  bucketCount = 12,
  height = 160,
}: LatencyHistogramProps): React.ReactElement {
  const buckets = useMemo(
    () => buildBuckets(samples.map((s) => s.responseTimeMs), bucketCount),
    [samples, bucketCount],
  );

  if (buckets.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-gray-200 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
        style={{ height }}
      >
        No latency samples yet
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={buckets} margin={{ top: 8, right: 8, bottom: 20, left: 8 }}>
          <XAxis
            dataKey="range"
            tick={{ fontSize: 10, fill: "#6b7280" }}
            axisLine={false}
            tickLine={false}
            interval={Math.max(0, Math.floor(bucketCount / 6) - 1)}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#6b7280" }}
            axisLine={false}
            tickLine={false}
            width={28}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(16,185,129,0.08)" }}
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              padding: "4px 8px",
            }}
            formatter={(value) => [`${value ?? 0} samples`, ""]}
          />
          <Bar dataKey="count" radius={[2, 2, 0, 0]}>
            {buckets.map((_, i) => (
              <Cell key={i} fill="#10b981" />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
