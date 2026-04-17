"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Server } from "lucide-react";

interface AgentRow {
  id: string;
  name: string;
  status: string;
  version?: string | null;
  last_seen?: string | null;
  hostname?: string | null;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function dotColor(status: string): string {
  if (status === "online") return "bg-emerald-500";
  if (status === "offline") return "bg-rose-500";
  if (status === "pending") return "bg-sky-400";
  return "bg-slate-400";
}

export function FleetStrip(): React.ReactElement {
  const { data, isLoading } = useQuery<AgentRow[]>({
    queryKey: ["/api/agents"],
    queryFn: async () => {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error("failed to load agents");
      return res.json();
    },
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-4 w-4 text-emerald-500" />
            Fleet
          </CardTitle>
          <CardDescription>
            {data ? `${data.length} agent${data.length === 1 ? "" : "s"}` : " "}
          </CardDescription>
        </div>
        <Link
          href="/agents"
          className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
        >
          Manage agents
        </Link>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-6 rounded-full" />
            ))}
          </div>
        ) : !data || data.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No agents enrolled.
          </div>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-2">
            {data.map((a) => (
              <Link
                key={a.id}
                href={`/agents/${a.id}`}
                title={`${a.name} · ${a.version ?? "unknown version"} · ${timeAgo(a.last_seen)}`}
                className="group flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white hover:border-emerald-400 dark:border-gray-700 dark:bg-gray-900"
              >
                <span
                  className={cn("h-3 w-3 rounded-full ring-2 ring-white dark:ring-gray-900", dotColor(a.status))}
                />
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
