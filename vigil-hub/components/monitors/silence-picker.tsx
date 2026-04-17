"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SilencePickerProps {
  onSilence: (until: Date) => void | Promise<void>;
  onUnsilence?: () => void | Promise<void>;
  silencedUntil?: string | null;
  disabled?: boolean;
}

const PRESETS: { label: string; minutes: number }[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
  { label: "24h", minutes: 60 * 24 },
];

function formatRel(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

export function SilencePicker({
  onSilence,
  onUnsilence,
  silencedUntil,
  disabled,
}: SilencePickerProps): React.ReactElement {
  const [custom, setCustom] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const activeSilence = silencedUntil && new Date(silencedUntil).getTime() > Date.now();

  const handlePreset = async (minutes: number) => {
    setBusy(true);
    try {
      await onSilence(new Date(Date.now() + minutes * 60_000));
    } finally {
      setBusy(false);
    }
  };

  const handleCustom = async () => {
    if (!custom) return;
    const d = new Date(custom);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return;
    setBusy(true);
    try {
      await onSilence(d);
    } finally {
      setBusy(false);
    }
  };

  const handleUnsilence = async () => {
    if (!onUnsilence) return;
    setBusy(true);
    try {
      await onUnsilence();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {activeSilence ? (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <span>
            Silenced (ends in {formatRel(silencedUntil)})
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleUnsilence}
            disabled={disabled || busy}
          >
            Unmute
          </Button>
        </div>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Silence suppresses alerts without stopping data collection.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant="outline"
            onClick={() => handlePreset(p.minutes)}
            disabled={disabled || busy}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="datetime-local"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          disabled={disabled || busy}
          className={cn(
            "h-9 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900",
            "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100",
          )}
        />
        <Button
          size="sm"
          variant="default"
          onClick={handleCustom}
          disabled={disabled || busy || !custom}
        >
          Silence until
        </Button>
      </div>
    </div>
  );
}
