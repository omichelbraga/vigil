"use client";

import { LineChart, Line, BarChart, Bar, ResponsiveContainer, YAxis } from "recharts";
import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  variant?: "line" | "bar";
  color?: string;
  height?: number;
  className?: string;
}

/**
 * Tiny axis-free sparkline. Defaults to emerald line, 48px tall.
 * Accepts any numeric series — values <= 0 render as a flat line at zero.
 */
export function Sparkline({
  data,
  variant = "line",
  color = "#10b981",
  height = 48,
  className,
}: SparklineProps): React.ReactElement {
  const chartData = data.map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }));
  const hasValues = chartData.some((d) => d.v > 0);
  // Give the chart a small non-zero range so the flat-zero case still renders
  const max = hasValues ? Math.max(...chartData.map((d) => d.v)) : 1;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === "bar" ? (
          <BarChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <YAxis domain={[0, max]} hide />
            <Bar dataKey="v" fill={color} radius={[1, 1, 0, 0]} />
          </BarChart>
        ) : (
          <LineChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <YAxis domain={[0, max]} hide />
            <Line
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
