import type { CheckStatus } from "@/lib/status";

export type BadgeVariant = "ok" | "warn" | "crit" | "info" | "muted";

/**
 * Map a free-form status string to the semantic Badge variant.
 */
export function statusToBadgeVariant(status: string | null | undefined): BadgeVariant {
  switch (status?.toLowerCase()) {
    case "ok":
    case "up":
    case "healthy":
    case "active":
      return "ok";
    case "warning":
    case "warn":
    case "degraded":
      return "warn";
    case "critical":
    case "crit":
    case "down":
    case "offline":
    case "error":
    case "failed":
      return "crit";
    case "info":
    case "pending":
      return "info";
    default:
      return "muted";
  }
}

export function checkStatusToBadgeVariant(status: CheckStatus): BadgeVariant {
  return statusToBadgeVariant(status);
}

/**
 * Hex color helpers — useful for recharts strokes / fills that can't use
 * Tailwind classes. Tied to the same emerald/amber/rose semantic scale used
 * across the app.
 */
export const semanticColors = {
  ok: "#10b981", // emerald-500
  warn: "#f59e0b", // amber-500
  crit: "#f43f5e", // rose-500
  info: "#0ea5e9", // sky-500
  muted: "#64748b", // slate-500
} as const;

export function statusToColor(status: string | null | undefined): string {
  return semanticColors[statusToBadgeVariant(status)];
}

/**
 * Background + text utility classes for status dots / pills. Kept for parity
 * with the existing `statusColor` helpers but tuned to emerald-led palette.
 */
export function statusToDotClass(status: string | null | undefined): string {
  switch (statusToBadgeVariant(status)) {
    case "ok":
      return "bg-emerald-500";
    case "warn":
      return "bg-amber-500";
    case "crit":
      return "bg-rose-500";
    case "info":
      return "bg-sky-500";
    default:
      return "bg-slate-400";
  }
}
