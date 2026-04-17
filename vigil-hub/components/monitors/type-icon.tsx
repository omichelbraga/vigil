"use client";

import {
  Globe,
  Network,
  Wifi,
  Cog,
  ShieldCheck,
  CalendarClock,
  Cpu,
  Terminal,
  FileText,
  ScrollText,
  HelpCircle,
} from "lucide-react";
import type { MonitorType } from "@/lib/monitors";
import { cn } from "@/lib/utils";

interface TypeIconProps {
  type: MonitorType;
  className?: string;
}

export function TypeIcon({ type, className }: TypeIconProps): React.ReactElement {
  const cls = cn("h-4 w-4", className);
  switch (type) {
    case "http":
      return <Globe className={cls} />;
    case "port":
      return <Network className={cls} />;
    case "ping":
      return <Wifi className={cls} />;
    case "service":
      return <Cog className={cls} />;
    case "cert":
      return <ShieldCheck className={cls} />;
    case "expiry":
      return <CalendarClock className={cls} />;
    case "resource":
      return <Cpu className={cls} />;
    case "process":
      return <Terminal className={cls} />;
    case "logfile":
      return <FileText className={cls} />;
    case "event_log":
      return <ScrollText className={cls} />;
    default:
      return <HelpCircle className={cls} />;
  }
}
