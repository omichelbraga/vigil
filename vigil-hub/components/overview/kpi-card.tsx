"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface KpiCardProps {
  label: string;
  value: string;
  secondary?: string;
  tone?: "ok" | "warn" | "crit" | "neutral";
  chart: ReactNode;
  loading?: boolean;
  className?: string;
}

export function KpiCard({
  label,
  value,
  secondary,
  tone = "neutral",
  chart,
  loading,
  className,
}: KpiCardProps): React.ReactElement {
  const toneBar =
    tone === "ok"
      ? "before:bg-emerald-500"
      : tone === "warn"
        ? "before:bg-amber-500"
        : tone === "crit"
          ? "before:bg-rose-500"
          : "before:bg-slate-300 dark:before:bg-slate-700";

  return (
    <Card
      className={cn(
        "relative overflow-hidden p-4",
        "before:absolute before:left-0 before:top-0 before:h-full before:w-[3px]",
        toneBar,
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {label}
          </div>
          <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">
            {loading ? <Skeleton className="h-7 w-20" /> : value}
          </div>
          {secondary ? (
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {loading ? <Skeleton className="mt-1 h-3 w-16" /> : secondary}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3">
        {loading ? <Skeleton className="h-12 w-full" /> : chart}
      </div>
    </Card>
  );
}
