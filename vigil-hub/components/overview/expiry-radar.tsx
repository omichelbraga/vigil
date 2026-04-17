"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Shield } from "lucide-react";

interface RadarItem {
  name: string;
  daysLeft: number;
  kind: "cert" | "expiry";
  href: string;
}

interface RadarBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  topItems: RadarItem[];
}

interface RadarResponse {
  buckets: RadarBucket[];
}

function bucketTone(min: number): { bar: string; text: string } {
  if (min <= 30) {
    return {
      bar: "bg-rose-500",
      text: "text-rose-700 dark:text-rose-300",
    };
  }
  if (min <= 60) {
    return {
      bar: "bg-amber-500",
      text: "text-amber-700 dark:text-amber-300",
    };
  }
  return {
    bar: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-300",
  };
}

export function ExpiryRadar(): React.ReactElement {
  const { data, isLoading } = useQuery<RadarResponse>({
    queryKey: ["/api/overview/expiry-radar"],
    queryFn: async () => {
      const res = await fetch("/api/overview/expiry-radar");
      if (!res.ok) throw new Error("failed to load expiry radar");
      return res.json();
    },
    refetchInterval: 5 * 60_000,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-emerald-500" />
            Expiry radar
          </CardTitle>
          <CardDescription>Certificates & secrets expiring within 90 days</CardDescription>
        </div>
        <div className="flex gap-3 text-xs">
          <Link
            href="/certificates"
            className="font-medium text-emerald-600 hover:underline dark:text-emerald-400"
          >
            Certs
          </Link>
          <Link
            href="/expiry"
            className="font-medium text-emerald-600 hover:underline dark:text-emerald-400"
          >
            Secrets
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {(data?.buckets ?? []).map((b) => {
              const tone = bucketTone(b.min);
              return (
                <div
                  key={b.label}
                  className="relative overflow-hidden rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className={cn("absolute left-0 top-0 h-full w-[3px]", tone.bar)} />
                  <div className="flex items-baseline justify-between">
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {b.label}
                    </div>
                    <div className={cn("text-2xl font-semibold tabular-nums", tone.text)}>
                      {b.count}
                    </div>
                  </div>
                  {b.topItems.length === 0 ? (
                    <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                      Nothing in this bucket.
                    </div>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {b.topItems.map((it) => (
                        <li key={`${it.kind}-${it.name}`} className="text-xs">
                          <Link
                            href={it.href}
                            className="flex items-center justify-between gap-2 text-gray-700 hover:text-emerald-600 dark:text-gray-300 dark:hover:text-emerald-400"
                          >
                            <span className="truncate">{it.name}</span>
                            <span className="flex-shrink-0 tabular-nums text-gray-400">
                              {it.daysLeft}d
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
