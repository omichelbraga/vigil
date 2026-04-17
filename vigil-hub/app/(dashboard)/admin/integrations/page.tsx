"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  MessageSquare,
  Radio,
  Gamepad2,
  Send,
  PhoneCall,
  Mail,
  Webhook,
  KeyRound,
  ShieldCheck,
  AlertOctagon,
  CheckCircle2,
  XCircle,
  Circle,
  Plug,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast-provider";

type IntegrationKind =
  | "slack"
  | "teams"
  | "discord"
  | "telegram"
  | "pagerduty"
  | "twilio"
  | "smtp"
  | "webhook"
  | "azure_kv"
  | "oauth_google"
  | "oauth_microsoft";

interface IntegrationSummary {
  kind: IntegrationKind;
  label: string;
  configured: boolean;
  enabled: boolean;
  channelId: string | null;
  lastDelivery: {
    status: "success" | "failed" | "retrying";
    sentAt: string;
  } | null;
}

interface ListResponse {
  integrations: IntegrationSummary[];
}

type FilterValue = "all" | "configured" | "enabled";

const KIND_ICONS: Record<IntegrationKind, React.ComponentType<{ className?: string }>> = {
  slack: MessageSquare,
  teams: Radio,
  discord: Gamepad2,
  telegram: Send,
  pagerduty: AlertOctagon,
  twilio: PhoneCall,
  smtp: Mail,
  webhook: Webhook,
  azure_kv: KeyRound,
  oauth_google: ShieldCheck,
  oauth_microsoft: ShieldCheck,
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed: ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return `${Math.max(diffSec, 0)}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export default function IntegrationsIndexPage(): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<FilterValue>("all");

  const listQuery = useQuery<ListResponse>({
    queryKey: ["admin", "integrations"],
    queryFn: () => apiJson<ListResponse>("/api/admin/integrations"),
    refetchOnWindowFocus: false,
  });

  const toggleMutation = useMutation({
    mutationFn: async (input: { kind: IntegrationKind; enabled: boolean }) =>
      apiJson(`/api/admin/integrations/${input.kind}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: input.enabled }),
      }),
    onMutate: async ({ kind, enabled }) => {
      await qc.cancelQueries({ queryKey: ["admin", "integrations"] });
      const prev = qc.getQueryData<ListResponse>(["admin", "integrations"]);
      if (prev) {
        qc.setQueryData<ListResponse>(["admin", "integrations"], {
          integrations: prev.integrations.map((i) =>
            i.kind === kind ? { ...i, enabled } : i,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin", "integrations"], ctx.prev);
      toast.error(
        "Toggle failed",
        err instanceof Error ? err.message : String(err),
      );
    },
    onSuccess: () => toast.success("Saved"),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations"] });
    },
  });

  const filtered = useMemo(() => {
    const list = listQuery.data?.integrations ?? [];
    if (filter === "configured") return list.filter((i) => i.configured);
    if (filter === "enabled") return list.filter((i) => i.enabled);
    return list;
  }, [listQuery.data, filter]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
            Integrations
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Connect Vigil to chat, paging, email, and identity providers. Every
            channel keeps its own delivery log.
          </p>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          label="All"
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <FilterChip
          label="Configured"
          active={filter === "configured"}
          onClick={() => setFilter("configured")}
        />
        <FilterChip
          label="Enabled"
          active={filter === "enabled"}
          onClick={() => setFilter("enabled")}
        />
      </div>

      {listQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center dark:border-gray-800 dark:bg-gray-900">
          <Plug className="mb-3 h-6 w-6 text-gray-400" />
          <p className="text-sm font-medium text-gray-900 dark:text-white">
            Nothing to show
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Change the filter above to see all integrations.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((i) => (
            <IntegrationCard
              key={i.kind}
              integration={i}
              onToggle={(enabled) =>
                toggleMutation.mutate({ kind: i.kind, enabled })
              }
              pending={
                toggleMutation.isPending &&
                toggleMutation.variables?.kind === i.kind
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
        active
          ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
      )}
    >
      {label}
    </button>
  );
}

function IntegrationCard({
  integration,
  onToggle,
  pending,
}: {
  integration: IntegrationSummary;
  onToggle: (enabled: boolean) => void;
  pending: boolean;
}): React.ReactElement {
  const Icon = KIND_ICONS[integration.kind];

  return (
    <div className="flex flex-col justify-between rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200">
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            {integration.label}
          </h3>
          <StatusPill integration={integration} />
        </div>
        <EnabledSwitch
          disabled={!integration.configured || pending}
          checked={integration.enabled}
          onChange={onToggle}
        />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        <LastDeliveryBadge last={integration.lastDelivery} />
        <Link href={`/admin/integrations/${integration.kind}`}>
          <Button variant="outline" size="sm" type="button">
            <Settings2 />
            Edit
          </Button>
        </Link>
      </div>
    </div>
  );
}

function StatusPill({
  integration,
}: {
  integration: IntegrationSummary;
}): React.ReactElement {
  if (!integration.configured) {
    return (
      <Badge variant="muted" className="mt-1">
        Not configured
      </Badge>
    );
  }
  if (!integration.enabled) {
    return (
      <Badge variant="muted" className="mt-1">
        Configured · Disabled
      </Badge>
    );
  }
  return (
    <Badge variant="ok" className="mt-1">
      Connected
    </Badge>
  );
}

function LastDeliveryBadge({
  last,
}: {
  last: IntegrationSummary["lastDelivery"];
}): React.ReactElement {
  if (!last) {
    return (
      <span className="inline-flex items-center gap-1">
        <Circle className="h-3 w-3" />
        No deliveries yet
      </span>
    );
  }
  const Icon = last.status === "success" ? CheckCircle2 : XCircle;
  const color =
    last.status === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  return (
    <span className={cn("inline-flex items-center gap-1", color)}>
      <Icon className="h-3.5 w-3.5" />
      Last: {relativeTime(last.sentAt)}
    </span>
  );
}

function EnabledSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-emerald-500 bg-emerald-500"
          : "border-gray-300 bg-gray-200 dark:border-gray-700 dark:bg-gray-700",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-4 w-4 translate-y-px rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
