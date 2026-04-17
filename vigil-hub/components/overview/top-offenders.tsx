"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Sparkline } from "./sparkline";
import { TrendingDown, ShieldCheck } from "lucide-react";

interface TopOffender {
  checkId: string;
  checkName: string;
  agentName: string;
  failureRate: number;
  totalResults: number;
  latencySparkline: number[];
}

interface TopOffendingChecksProps {
  limit?: number;
}

export function TopOffendingChecks({ limit = 5 }: TopOffendingChecksProps): React.ReactElement {
  const { data, isLoading } = useQuery<TopOffender[]>({
    queryKey: [`/api/overview/top-offenders?limit=${limit}`],
    queryFn: async () => {
      const res = await fetch(`/api/overview/top-offenders?limit=${limit}`);
      if (!res.ok) throw new Error("failed to load top offenders");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-rose-500" />
            Top offending checks
          </CardTitle>
          <CardDescription>Ranked by failure rate — last 7 days</CardDescription>
        </div>
        <Link
          href="/checks"
          className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
        >
          All checks
        </Link>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: limit }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-8 w-24" />
              </div>
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No misbehaving checks"
            description="Every check has passed cleanly in the last 7 days."
          />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.map((row) => {
              const pct = (row.failureRate * 100).toFixed(1);
              const tone =
                row.failureRate >= 0.25
                  ? "text-rose-600 dark:text-rose-400"
                  : row.failureRate >= 0.1
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-gray-600 dark:text-gray-400";
              return (
                <li key={row.checkId} className="py-2.5">
                  <Link
                    href={`/checks?check=${row.checkId}`}
                    className="flex items-center gap-3 rounded-md px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {row.checkName}
                      </div>
                      <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {row.agentName} · {row.totalResults} results
                      </div>
                    </div>
                    <div className={`w-14 text-right text-sm font-semibold tabular-nums ${tone}`}>
                      {pct}%
                    </div>
                    <div className="w-24">
                      <Sparkline
                        data={row.latencySparkline}
                        variant="line"
                        color="#f43f5e"
                        height={32}
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
