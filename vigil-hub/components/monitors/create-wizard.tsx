"use client";

import { useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TypeIcon } from "./type-icon";
import { useToast } from "@/components/ui/toast-provider";
import { cn } from "@/lib/utils";
import type { MonitorType } from "@/lib/monitors";
import { ALL_MONITOR_TYPES, monitorTypeLabel } from "@/lib/monitors";

interface CreateWizardProps {
  open: boolean;
  onClose: () => void;
}

interface AgentOption {
  id: string;
  name: string;
}

interface ChannelOption {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

type StepKey = "type" | "target" | "thresholds" | "alerting" | "review";

const STEPS: { key: StepKey; label: string }[] = [
  { key: "type", label: "Type" },
  { key: "target", label: "Target" },
  { key: "thresholds", label: "Thresholds" },
  { key: "alerting", label: "Alerting" },
  { key: "review", label: "Review" },
];

const TYPE_DESCRIPTIONS: Record<MonitorType, string> = {
  http: "Hit a URL and verify status code / body keyword.",
  port: "TCP connect to host:port.",
  ping: "ICMP ping a host with a round-trip budget.",
  service: "Check a systemd unit (Linux) or SCM service (Windows).",
  cert: "Poll a TLS endpoint and track its certificate expiration.",
  expiry: "Track a manual expiration date (App secrets, SAML certs, licenses).",
  resource: "Alert when CPU / RAM / Disk exceed thresholds on the agent host.",
  process: "Ensure a named process is running on the agent.",
  logfile: "Watch a log file for a regex pattern match / no-match window.",
  event_log: "Watch the Windows event log for a channel/event id.",
};

const EXPIRY_CATEGORIES: { value: string; label: string }[] = [
  { value: "api_key", label: "API Key" },
  { value: "cert", label: "Certificate" },
  { value: "secret", label: "Secret" },
  { value: "license", label: "License" },
  { value: "other", label: "Other" },
];

// ── Type-specific config state shape ────────────────────────
interface ConfigState {
  // http
  url: string;
  expected_status: string;
  body_keyword: string;
  timeout_ms: string;
  // port / cert
  host: string;
  port: string;
  // ping
  ping_target: string;
  ping_count: string;
  // service
  service_name: string;
  // cert
  cert_warn_days: string;
  // expiry
  exp_name: string;
  exp_category: string;
  exp_expires_at: string;
  exp_warn_days: string;
  exp_description: string;
  // resource
  cpu_alert_pct: string;
  ram_alert_pct: string;
  disk_alert_pct: string;
  // process
  process_name: string;
  // logfile
  log_path: string;
  log_pattern: string;
  log_fire_on: "match" | "no-match-within";
  log_window_secs: string;
  // event_log
  ev_channel: string;
  ev_provider: string;
  ev_event_id: string;
}

const INITIAL_CONFIG: ConfigState = {
  url: "https://",
  expected_status: "200",
  body_keyword: "",
  timeout_ms: "5000",
  host: "",
  port: "443",
  ping_target: "",
  ping_count: "4",
  service_name: "",
  cert_warn_days: "30",
  exp_name: "",
  exp_category: "cert",
  exp_expires_at: "",
  exp_warn_days: "30",
  exp_description: "",
  cpu_alert_pct: "90",
  ram_alert_pct: "85",
  disk_alert_pct: "90",
  process_name: "",
  log_path: "",
  log_pattern: "",
  log_fire_on: "match",
  log_window_secs: "300",
  ev_channel: "System",
  ev_provider: "",
  ev_event_id: "",
};

interface StepValidation {
  ok: boolean;
  warnings: string[];
}

function validateTarget(type: MonitorType | null, cfg: ConfigState): StepValidation {
  const warnings: string[] = [];
  if (!type) return { ok: false, warnings: ["Pick a monitor type first."] };
  switch (type) {
    case "http": {
      try {
        const u = new URL(cfg.url);
        if (!/^https?:/.test(u.protocol)) return { ok: false, warnings: ["URL must be http(s)."] };
      } catch {
        return { ok: false, warnings: ["Invalid URL."] };
      }
      const es = parseInt(cfg.expected_status, 10);
      if (!Number.isInteger(es) || es < 100 || es > 599)
        return { ok: false, warnings: ["Expected status must be 100–599."] };
      return { ok: true, warnings };
    }
    case "port": {
      if (!cfg.host.trim()) return { ok: false, warnings: ["Host required."] };
      const p = parseInt(cfg.port, 10);
      if (!Number.isInteger(p) || p < 1 || p > 65535)
        return { ok: false, warnings: ["Port must be 1–65535."] };
      return { ok: true, warnings };
    }
    case "ping": {
      if (!cfg.ping_target.trim()) return { ok: false, warnings: ["Target required."] };
      return { ok: true, warnings };
    }
    case "service": {
      const n = cfg.service_name.trim();
      if (!n) return { ok: false, warnings: ["Service name required."] };
      if (n.startsWith("-")) return { ok: false, warnings: ["Service name cannot start with '-'."] };
      warnings.push("Linux uses systemd unit names (e.g. nginx.service); Windows uses SCM service names (e.g. Spooler).");
      return { ok: true, warnings };
    }
    case "cert": {
      if (!cfg.host.trim()) return { ok: false, warnings: ["Host required."] };
      return { ok: true, warnings };
    }
    case "expiry": {
      if (!cfg.exp_name.trim()) return { ok: false, warnings: ["Name required."] };
      if (!cfg.exp_expires_at) return { ok: false, warnings: ["Expiration date required."] };
      return { ok: true, warnings };
    }
    case "resource": {
      const cpu = parseFloat(cfg.cpu_alert_pct);
      const ram = parseFloat(cfg.ram_alert_pct);
      const disk = parseFloat(cfg.disk_alert_pct);
      if ([cpu, ram, disk].some((v) => !Number.isFinite(v) || v < 1 || v > 100))
        return { ok: false, warnings: ["All thresholds must be 1–100."] };
      return { ok: true, warnings };
    }
    case "process": {
      if (!cfg.process_name.trim()) return { ok: false, warnings: ["Process name required."] };
      return { ok: true, warnings };
    }
    case "logfile": {
      if (!cfg.log_path.trim()) return { ok: false, warnings: ["Path required."] };
      if (!cfg.log_pattern.trim()) return { ok: false, warnings: ["Regex pattern required."] };
      try {
        new RegExp(cfg.log_pattern);
      } catch {
        return { ok: false, warnings: ["Invalid regex."] };
      }
      return { ok: true, warnings };
    }
    case "event_log": {
      if (!cfg.ev_channel.trim()) return { ok: false, warnings: ["Channel required."] };
      return { ok: true, warnings };
    }
    default:
      return { ok: false, warnings: ["Unsupported type."] };
  }
}

function buildCheckConfig(type: MonitorType, cfg: ConfigState): Record<string, unknown> {
  switch (type) {
    case "http":
      return {
        url: cfg.url,
        expected_status: parseInt(cfg.expected_status, 10),
        timeout_ms: parseInt(cfg.timeout_ms, 10) || 5000,
        ...(cfg.body_keyword ? { body_keyword: cfg.body_keyword } : {}),
      };
    case "port":
      return {
        host: cfg.host,
        port: parseInt(cfg.port, 10),
        timeout_ms: parseInt(cfg.timeout_ms, 10) || 5000,
      };
    case "ping":
      return {
        host: cfg.ping_target,
        target: cfg.ping_target,
        count: parseInt(cfg.ping_count, 10) || 4,
        timeout_ms: parseInt(cfg.timeout_ms, 10) || 5000,
      };
    case "service":
      return { name: cfg.service_name, service_name: cfg.service_name };
    case "cert":
      return {
        host: cfg.host,
        port: parseInt(cfg.port, 10) || 443,
        warn_days: parseInt(cfg.cert_warn_days, 10) || 30,
      };
    case "resource":
      return {
        cpu_alert_pct: parseFloat(cfg.cpu_alert_pct),
        ram_alert_pct: parseFloat(cfg.ram_alert_pct),
        disk_alert_pct: parseFloat(cfg.disk_alert_pct),
      };
    case "process":
      return { process_name: cfg.process_name, name: cfg.process_name };
    case "logfile":
      return {
        path: cfg.log_path,
        pattern: cfg.log_pattern,
        fire_on: cfg.log_fire_on,
        window_secs: parseInt(cfg.log_window_secs, 10) || 300,
      };
    case "event_log":
      return {
        channel: cfg.ev_channel,
        ...(cfg.ev_provider ? { provider: cfg.ev_provider } : {}),
        ...(cfg.ev_event_id ? { event_id: parseInt(cfg.ev_event_id, 10) } : {}),
      };
    default:
      return {};
  }
}

interface ReviewSummary {
  label: string;
  value: string;
}

function buildSummary(
  type: MonitorType,
  cfg: ConfigState,
  agentName: string | null,
  intervalSecs: number,
  slo: number | null,
  channels: ChannelOption[],
  selectedChannels: Set<string>,
): ReviewSummary[] {
  const s: ReviewSummary[] = [];
  s.push({ label: "Type", value: monitorTypeLabel(type) });
  if (type === "expiry") {
    s.push({ label: "Name", value: cfg.exp_name });
    s.push({ label: "Category", value: cfg.exp_category });
    s.push({ label: "Expires at", value: cfg.exp_expires_at });
    s.push({ label: "Warn days", value: cfg.exp_warn_days });
  } else if (type === "cert") {
    s.push({ label: "Host", value: `${cfg.host}:${cfg.port}` });
    s.push({ label: "Warn days", value: cfg.cert_warn_days });
  } else {
    if (agentName) s.push({ label: "Agent", value: agentName });
    s.push({ label: "Target", value: JSON.stringify(buildCheckConfig(type, cfg)) });
    s.push({ label: "Interval", value: `${intervalSecs}s` });
    if (slo != null) s.push({ label: "SLO", value: `${slo}%` });
  }
  const selected = channels.filter((c) => selectedChannels.has(c.id));
  if (selected.length > 0) {
    s.push({ label: "Channels", value: selected.map((c) => c.name).join(", ") });
  } else {
    s.push({ label: "Channels", value: "(default — all enabled)" });
  }
  return s;
}

export function CreateWizard({ open, onClose }: CreateWizardProps): React.ReactElement {
  const [stepIdx, setStepIdx] = useState(0);
  const [type, setType] = useState<MonitorType | null>(null);
  const [cfg, setCfg] = useState<ConfigState>(INITIAL_CONFIG);
  const [agentId, setAgentId] = useState<string>("");
  const [intervalSecs, setIntervalSecs] = useState<string>("60");
  const [slo, setSlo] = useState<string>("");
  const [checkName, setCheckName] = useState<string>("");
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());

  const { success, error: toastError } = useToast();
  const qc = useQueryClient();

  const agentsQuery = useQuery<AgentOption[]>({
    queryKey: ["wizard-agents"],
    enabled: open,
    queryFn: async () => {
      const res = await fetch("/api/agents");
      if (!res.ok) return [];
      const data = (await res.json()) as AgentOption[];
      return Array.isArray(data) ? data : [];
    },
  });

  const channelsQuery = useQuery<ChannelOption[]>({
    queryKey: ["wizard-channels"],
    enabled: open,
    queryFn: async () => {
      // /api/settings exposes aggregate channel flags; we need channel list with ids.
      const res = await fetch("/api/settings");
      if (!res.ok) return [];
      // We don't want to build a dep on internal fields — fall back to empty.
      return [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!type) throw new Error("no type");
      if (type === "expiry") {
        const res = await fetch("/api/expiry-monitors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: cfg.exp_name,
            description: cfg.exp_description || null,
            category: cfg.exp_category,
            expiresAt: cfg.exp_expires_at,
            warnDays: parseInt(cfg.exp_warn_days, 10) || 30,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to create expiry monitor");
        }
        return res.json();
      }
      if (type === "cert") {
        const res = await fetch("/api/certs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain: cfg.host,
            port: parseInt(cfg.port, 10) || 443,
            warnDays: parseInt(cfg.cert_warn_days, 10) || 30,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Failed to create cert monitor");
        }
        return res.json();
      }
      // Agent-side check
      if (!agentId) throw new Error("Agent required");
      const autoName =
        checkName.trim() ||
        `${monitorTypeLabel(type)}${cfg.host ? `: ${cfg.host}` : cfg.url ? `: ${cfg.url}` : ""}`;
      const res = await fetch("/api/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          name: autoName,
          type,
          config: buildCheckConfig(type, cfg),
          intervalSecs: parseInt(intervalSecs, 10) || 60,
          ...(slo ? { slo: parseFloat(slo) } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create check");
      }
      return res.json();
    },
    onSuccess: () => {
      success("Monitor created");
      qc.invalidateQueries({ queryKey: ["monitors"] });
      resetAndClose();
    },
    onError: (e: Error) => {
      toastError(e.message);
    },
  });

  const resetAndClose = () => {
    setStepIdx(0);
    setType(null);
    setCfg(INITIAL_CONFIG);
    setAgentId("");
    setIntervalSecs("60");
    setSlo("");
    setCheckName("");
    setChannelIds(new Set());
    onClose();
  };

  // Step validation
  const stepValid = useMemo<StepValidation>(() => {
    const step = STEPS[stepIdx];
    if (step.key === "type") return { ok: type != null, warnings: [] };
    if (step.key === "target") return validateTarget(type, cfg);
    if (step.key === "thresholds") {
      if (type === "cert" || type === "expiry") return { ok: true, warnings: [] };
      const i = parseInt(intervalSecs, 10);
      if (!Number.isInteger(i) || i < 5 || i > 86400)
        return { ok: false, warnings: ["Interval must be between 5 and 86400 seconds."] };
      if (slo) {
        const s = parseFloat(slo);
        if (!Number.isFinite(s) || s < 0 || s > 100)
          return { ok: false, warnings: ["SLO must be 0–100."] };
      }
      if ((type === "http" || type === "port" || type === "ping" || type === "service" || type === "resource" || type === "process" || type === "logfile" || type === "event_log") && !agentId) {
        return { ok: false, warnings: ["Select an agent."] };
      }
      return { ok: true, warnings: [] };
    }
    if (step.key === "alerting") return { ok: true, warnings: [] };
    return { ok: true, warnings: [] };
  }, [stepIdx, type, cfg, agentId, intervalSecs, slo]);

  const targetValidation = useMemo(() => validateTarget(type, cfg), [type, cfg]);

  const goNext = () => {
    if (!stepValid.ok) return;
    if (stepIdx < STEPS.length - 1) setStepIdx(stepIdx + 1);
  };
  const goBack = () => {
    if (stepIdx > 0) setStepIdx(stepIdx - 1);
  };

  const summary = useMemo(() => {
    if (!type) return [];
    const agentName = agentsQuery.data?.find((a) => a.id === agentId)?.name ?? null;
    return buildSummary(
      type,
      cfg,
      agentName,
      parseInt(intervalSecs, 10) || 60,
      slo ? parseFloat(slo) : null,
      channelsQuery.data ?? [],
      channelIds,
    );
  }, [type, cfg, agentId, intervalSecs, slo, agentsQuery.data, channelsQuery.data, channelIds]);

  const currentStep = STEPS[stepIdx];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) resetAndClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-white shadow-2xl dark:bg-gray-950"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-4 border-b border-gray-200 p-5 dark:border-gray-800">
            <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
              Create Monitor
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label="Close" className="h-8 w-8">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          {/* Stepper */}
          <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-3 text-xs dark:border-gray-800">
            {STEPS.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold",
                    i < stepIdx
                      ? "border-emerald-600 bg-emerald-600 text-white"
                      : i === stepIdx
                        ? "border-emerald-600 text-emerald-600 dark:text-emerald-400"
                        : "border-gray-300 text-gray-400 dark:border-gray-700",
                  )}
                >
                  {i < stepIdx ? <Check className="h-3 w-3" /> : i + 1}
                </div>
                <span
                  className={cn(
                    "font-medium",
                    i === stepIdx
                      ? "text-gray-900 dark:text-white"
                      : "text-gray-500 dark:text-gray-400",
                  )}
                >
                  {s.label}
                </span>
                {i < STEPS.length - 1 ? (
                  <span className="h-px w-8 bg-gray-200 dark:bg-gray-800" />
                ) : null}
              </div>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {currentStep.key === "type" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {ALL_MONITOR_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      "flex flex-col gap-2 rounded-xl border p-3 text-left transition-all",
                      type === t
                        ? "border-emerald-500 bg-emerald-50 shadow-sm dark:bg-emerald-950/40"
                        : "border-gray-200 hover:border-gray-300 dark:border-gray-800 dark:hover:border-gray-700",
                    )}
                  >
                    <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-white">
                      <TypeIcon type={t} />
                      {monitorTypeLabel(t)}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {TYPE_DESCRIPTIONS[t]}
                    </p>
                  </button>
                ))}
              </div>
            ) : null}

            {currentStep.key === "target" && type ? (
              <TargetFields type={type} cfg={cfg} setCfg={setCfg} />
            ) : null}

            {currentStep.key === "target" && targetValidation.warnings.length > 0 ? (
              <ul className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                {targetValidation.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}

            {currentStep.key === "thresholds" && type ? (
              <ThresholdsFields
                type={type}
                agents={agentsQuery.data ?? []}
                agentId={agentId}
                setAgentId={setAgentId}
                intervalSecs={intervalSecs}
                setIntervalSecs={setIntervalSecs}
                slo={slo}
                setSlo={setSlo}
                checkName={checkName}
                setCheckName={setCheckName}
              />
            ) : null}

            {currentStep.key === "alerting" ? (
              <AlertingFields
                channels={channelsQuery.data ?? []}
                channelIds={channelIds}
                setChannelIds={setChannelIds}
              />
            ) : null}

            {currentStep.key === "review" && type ? (
              <ReviewPanel summary={summary} />
            ) : null}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-gray-200 p-4 dark:border-gray-800">
            <div className="text-xs text-gray-400">
              Step {stepIdx + 1} / {STEPS.length}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={goBack}
                disabled={stepIdx === 0}
              >
                <ChevronLeft /> Back
              </Button>
              {stepIdx < STEPS.length - 1 ? (
                <Button
                  size="sm"
                  onClick={goNext}
                  disabled={!stepValid.ok}
                >
                  Next <ChevronRight />
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => createMutation.mutate()}
                  disabled={createMutation.isPending || !stepValid.ok}
                >
                  {createMutation.isPending ? "Creating…" : "Create"}
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Sub-panels ────────────────────────────────────────────────

function labelCls(): string {
  return "block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1";
}

function inputCls(): string {
  return cn(
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm",
    "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100",
  );
}

function TargetFields({
  type,
  cfg,
  setCfg,
}: {
  type: MonitorType;
  cfg: ConfigState;
  setCfg: React.Dispatch<React.SetStateAction<ConfigState>>;
}) {
  const update = (patch: Partial<ConfigState>) => setCfg((p) => ({ ...p, ...patch }));

  switch (type) {
    case "http":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>URL</label>
            <input className={inputCls()} type="url" value={cfg.url} onChange={(e) => update({ url: e.target.value })} placeholder="https://example.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls()}>Expected status</label>
              <input className={inputCls()} type="number" value={cfg.expected_status} onChange={(e) => update({ expected_status: e.target.value })} />
            </div>
            <div>
              <label className={labelCls()}>Timeout (ms)</label>
              <input className={inputCls()} type="number" value={cfg.timeout_ms} onChange={(e) => update({ timeout_ms: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls()}>Body keyword (optional)</label>
            <input className={inputCls()} type="text" value={cfg.body_keyword} onChange={(e) => update({ body_keyword: e.target.value })} placeholder="e.g. OK" />
          </div>
        </div>
      );
    case "port":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Host</label>
            <input className={inputCls()} value={cfg.host} onChange={(e) => update({ host: e.target.value })} placeholder="example.com or 10.0.0.1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls()}>Port</label>
              <input className={inputCls()} type="number" value={cfg.port} onChange={(e) => update({ port: e.target.value })} />
            </div>
            <div>
              <label className={labelCls()}>Timeout (ms)</label>
              <input className={inputCls()} type="number" value={cfg.timeout_ms} onChange={(e) => update({ timeout_ms: e.target.value })} />
            </div>
          </div>
        </div>
      );
    case "ping":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Target (hostname or IP)</label>
            <input className={inputCls()} value={cfg.ping_target} onChange={(e) => update({ ping_target: e.target.value })} placeholder="1.1.1.1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls()}>Count</label>
              <input className={inputCls()} type="number" value={cfg.ping_count} onChange={(e) => update({ ping_count: e.target.value })} />
            </div>
            <div>
              <label className={labelCls()}>Timeout (ms)</label>
              <input className={inputCls()} type="number" value={cfg.timeout_ms} onChange={(e) => update({ timeout_ms: e.target.value })} />
            </div>
          </div>
        </div>
      );
    case "service":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Service name</label>
            <input className={inputCls()} value={cfg.service_name} onChange={(e) => update({ service_name: e.target.value })} placeholder="nginx.service or Spooler" />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Linux: systemd unit name. Windows: SCM service name. Cannot start with a dash.
            </p>
          </div>
        </div>
      );
    case "cert":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Hostname</label>
            <input className={inputCls()} value={cfg.host} onChange={(e) => update({ host: e.target.value })} placeholder="example.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls()}>Port</label>
              <input className={inputCls()} type="number" value={cfg.port} onChange={(e) => update({ port: e.target.value })} />
            </div>
            <div>
              <label className={labelCls()}>Warn days</label>
              <input className={inputCls()} type="number" value={cfg.cert_warn_days} onChange={(e) => update({ cert_warn_days: e.target.value })} />
            </div>
          </div>
        </div>
      );
    case "expiry":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Name</label>
            <input className={inputCls()} value={cfg.exp_name} onChange={(e) => update({ exp_name: e.target.value })} placeholder="Intuneget App Secret" />
          </div>
          <div>
            <label className={labelCls()}>Category</label>
            <select className={inputCls()} value={cfg.exp_category} onChange={(e) => update({ exp_category: e.target.value })}>
              {EXPIRY_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls()}>Expires at</label>
              <input className={inputCls()} type="date" value={cfg.exp_expires_at} onChange={(e) => update({ exp_expires_at: e.target.value })} />
            </div>
            <div>
              <label className={labelCls()}>Warn days</label>
              <input className={inputCls()} type="number" value={cfg.exp_warn_days} onChange={(e) => update({ exp_warn_days: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls()}>Description (optional)</label>
            <input className={inputCls()} value={cfg.exp_description} onChange={(e) => update({ exp_description: e.target.value })} />
          </div>
        </div>
      );
    case "resource":
      return (
        <div className="space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Warning is raised when any threshold is exceeded on the agent host.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls()}>CPU %</label>
              <input className={inputCls()} type="number" value={cfg.cpu_alert_pct} onChange={(e) => update({ cpu_alert_pct: e.target.value })} />
            </div>
            <div>
              <label className={labelCls()}>RAM %</label>
              <input className={inputCls()} type="number" value={cfg.ram_alert_pct} onChange={(e) => update({ ram_alert_pct: e.target.value })} />
            </div>
            <div>
              <label className={labelCls()}>Disk %</label>
              <input className={inputCls()} type="number" value={cfg.disk_alert_pct} onChange={(e) => update({ disk_alert_pct: e.target.value })} />
            </div>
          </div>
        </div>
      );
    case "process":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Process name</label>
            <input className={inputCls()} value={cfg.process_name} onChange={(e) => update({ process_name: e.target.value })} placeholder="postgres" />
          </div>
        </div>
      );
    case "logfile":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Path</label>
            <input className={inputCls()} value={cfg.log_path} onChange={(e) => update({ log_path: e.target.value })} placeholder="/var/log/syslog" />
          </div>
          <div>
            <label className={labelCls()}>Regex pattern</label>
            <input className={inputCls()} value={cfg.log_pattern} onChange={(e) => update({ log_pattern: e.target.value })} placeholder="ERROR|CRITICAL" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls()}>Fire on</label>
              <select className={inputCls()} value={cfg.log_fire_on} onChange={(e) => update({ log_fire_on: e.target.value as "match" | "no-match-within" })}>
                <option value="match">Match</option>
                <option value="no-match-within">No match within window</option>
              </select>
            </div>
            <div>
              <label className={labelCls()}>Window (secs)</label>
              <input className={inputCls()} type="number" value={cfg.log_window_secs} onChange={(e) => update({ log_window_secs: e.target.value })} />
            </div>
          </div>
        </div>
      );
    case "event_log":
      return (
        <div className="space-y-3">
          <div>
            <label className={labelCls()}>Channel</label>
            <select className={inputCls()} value={cfg.ev_channel} onChange={(e) => update({ ev_channel: e.target.value })}>
              <option value="System">System</option>
              <option value="Application">Application</option>
              <option value="Security">Security</option>
            </select>
          </div>
          <div>
            <label className={labelCls()}>Provider (optional)</label>
            <input className={inputCls()} value={cfg.ev_provider} onChange={(e) => update({ ev_provider: e.target.value })} />
          </div>
          <div>
            <label className={labelCls()}>Event id (optional)</label>
            <input className={inputCls()} type="number" value={cfg.ev_event_id} onChange={(e) => update({ ev_event_id: e.target.value })} />
          </div>
        </div>
      );
    default:
      return null;
  }
}

function ThresholdsFields({
  type,
  agents,
  agentId,
  setAgentId,
  intervalSecs,
  setIntervalSecs,
  slo,
  setSlo,
  checkName,
  setCheckName,
}: {
  type: MonitorType;
  agents: AgentOption[];
  agentId: string;
  setAgentId: (v: string) => void;
  intervalSecs: string;
  setIntervalSecs: (v: string) => void;
  slo: string;
  setSlo: (v: string) => void;
  checkName: string;
  setCheckName: (v: string) => void;
}) {
  const needsAgent = type !== "cert" && type !== "expiry";
  const showThresholds = type !== "cert" && type !== "expiry";

  return (
    <div className="space-y-3">
      {needsAgent ? (
        <div>
          <label className={labelCls()}>Agent</label>
          <select className={inputCls()} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Select an agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {needsAgent ? (
        <div>
          <label className={labelCls()}>Monitor name (optional — auto-derived)</label>
          <input
            className={inputCls()}
            value={checkName}
            onChange={(e) => setCheckName(e.target.value)}
            placeholder="Leave blank to auto-name"
          />
        </div>
      ) : null}

      {showThresholds ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls()}>Interval (secs)</label>
            <input
              className={inputCls()}
              type="number"
              min={5}
              max={86400}
              value={intervalSecs}
              onChange={(e) => setIntervalSecs(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls()}>SLO % (optional)</label>
            <input
              className={inputCls()}
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={slo}
              onChange={(e) => setSlo(e.target.value)}
              placeholder="99.9"
            />
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {type === "cert"
            ? "Cert monitors run on the hub on a fixed schedule."
            : "Expiry monitors run on the hub daily."}
        </p>
      )}
    </div>
  );
}

function AlertingFields({
  channels,
  channelIds,
  setChannelIds,
}: {
  channels: ChannelOption[];
  channelIds: Set<string>;
  setChannelIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const toggle = (id: string) => {
    setChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (channels.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        No alert channels configured. The default behaviour fires alerts to every enabled
        channel. You can configure channels in Settings → Alerts.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Leave empty to use the default (all enabled channels).
      </p>
      {channels.map((c) => (
        <label
          key={c.id}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          <input
            type="checkbox"
            checked={channelIds.has(c.id)}
            onChange={() => toggle(c.id)}
            className="accent-emerald-600"
          />
          <span className="flex-1 font-medium text-gray-900 dark:text-white">{c.name}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {c.type} {c.enabled ? "" : "(disabled)"}
          </span>
        </label>
      ))}
    </div>
  );
}

function ReviewPanel({ summary }: { summary: ReviewSummary[] }) {
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          {summary.map((s) => (
            <div key={s.label} className="contents">
              <dt className="text-gray-500 dark:text-gray-400">{s.label}</dt>
              <dd className="break-words text-gray-900 dark:text-white">{s.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Review the details above. Creating a monitor will push it to the target (agent or
        hub scheduler) immediately.
      </p>
    </div>
  );
}
