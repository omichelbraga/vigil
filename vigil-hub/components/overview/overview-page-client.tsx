"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Server } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { KpiRow } from "./kpi-row";
import { TopOffendingChecks } from "./top-offenders";
import { IncidentFeed } from "./incident-feed";
import { FleetStrip } from "./fleet-strip";
import { ExpiryRadar } from "./expiry-radar";

interface AgentRow {
  id: string;
  name: string;
  status: string;
}

export function OverviewPageClient(): React.ReactElement {
  // Use the same query key as FleetStrip so it's de-duped by TanStack Query.
  const { data: agents, isLoading } = useQuery<AgentRow[]>({
    queryKey: ["/api/agents"],
    queryFn: async () => {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error("failed to load agents");
      return res.json();
    },
    refetchInterval: 15_000,
  });

  // First-run empty state: zero agents enrolled — show one big CTA.
  if (!isLoading && agents && agents.length === 0) {
    return (
      <div className="mx-auto max-w-2xl py-12">
        <EmptyState
          icon={Server}
          title="Enroll your first agent"
          description="Vigil needs at least one agent to start monitoring. Install the agent binary on a host, then enroll it here."
          action={
            <Link href="/agents">
              <Button>Go to Agents</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      <KpiRow />

      <div className="col-span-12 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <TopOffendingChecks limit={5} />
        </div>
        <div className="lg:col-span-4">
          <IncidentFeed limit={10} />
        </div>
      </div>

      <div className="col-span-12">
        <FleetStrip />
      </div>

      <div className="col-span-12">
        <ExpiryRadar />
      </div>
    </div>
  );
}
