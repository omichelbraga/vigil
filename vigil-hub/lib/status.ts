export type CheckStatus = "ok" | "warning" | "critical" | "unknown" | "offline";

export function statusLabel(status: string): string {
  switch (status?.toLowerCase()) {
    case "ok": return "OK";
    case "warning": return "Warning";
    case "critical": return "Critical";
    case "unknown": return "Unknown";
    case "offline": return "Offline";
    default: return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
  }
}

export function statusColor(status: string): string {
  switch (status?.toLowerCase()) {
    case "ok":
      return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400";
    case "warning":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
    case "critical":
    case "offline":
      return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400";
  }
}

export function statusDot(status: string): string {
  switch (status?.toLowerCase()) {
    case "ok": return "bg-green-500";
    case "warning": return "bg-amber-500";
    case "critical":
    case "offline": return "bg-red-500";
    default: return "bg-gray-400";
  }
}
