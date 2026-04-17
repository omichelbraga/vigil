"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  Activity,
  AlertTriangle,
  Bell,
  FileText,
  LayoutDashboard,
  LogOut,
  Moon,
  Plus,
  Radar,
  Search,
  Server,
  Shield,
  Sun,
  User,
  UserPlus,
  Users,
  Laptop,
} from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { useCommandPalette } from "@/hooks/use-command-palette";
import { useToast } from "@/components/ui/toast-provider";
import { cn } from "@/lib/utils";
import type {
  SearchIndexResponse,
  SearchIndexAgent,
  SearchIndexMonitor,
  SearchIndexIncident,
} from "@/app/api/search-index/route";

/** Role embedded by Better Auth on the session user. */
type SessionRole = "admin" | "editor" | "viewer" | undefined;

async function fetchSearchIndex(): Promise<SearchIndexResponse> {
  const res = await fetch("/api/search-index", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`search-index ${res.status}`);
  }
  return (await res.json()) as SearchIndexResponse;
}

/** ── g-prefix (vim-style) navigation ─────────────────────────────── */

interface GPrefixState {
  active: boolean;
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function useGPrefixHotkeys(opts: {
  isAdmin: boolean;
  onPrefixChange: (active: boolean) => void;
  onNavigate: (href: string) => void;
}): void {
  const { isAdmin, onPrefixChange, onNavigate } = opts;
  const prefixTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inPrefix = useRef<boolean>(false);

  const clearPrefix = useCallback((): void => {
    if (prefixTimer.current) {
      clearTimeout(prefixTimer.current);
      prefixTimer.current = null;
    }
    if (inPrefix.current) {
      inPrefix.current = false;
      onPrefixChange(false);
    }
  }, [onPrefixChange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        clearPrefix();
        return;
      }
      if (isEditableTarget(e.target)) {
        clearPrefix();
        return;
      }

      if (!inPrefix.current) {
        if (e.key === "g" || e.key === "G") {
          inPrefix.current = true;
          onPrefixChange(true);
          prefixTimer.current = setTimeout(clearPrefix, 1000);
        }
        return;
      }

      // In prefix mode — resolve the next key.
      e.preventDefault();
      const key = e.key.toLowerCase();
      let target: string | null = null;
      switch (key) {
        case "a":
          target = "/agents";
          break;
        case "m":
          target = "/monitors";
          break;
        case "i":
          target = "/alerts";
          break;
        case "s":
          target = isAdmin ? "/admin/users" : "/settings";
          break;
        case "p":
          target = "/profile";
          break;
        case "o":
          target = "/dashboard";
          break;
        default:
          target = null;
      }
      clearPrefix();
      if (target !== null) {
        onNavigate(target);
      }
    };

    window.addEventListener("keydown", handler);
    return (): void => {
      window.removeEventListener("keydown", handler);
      clearPrefix();
    };
  }, [clearPrefix, isAdmin, onNavigate, onPrefixChange]);
}

/** ── Prefers-reduced-motion ──────────────────────────────────────── */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return (): void => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** ── Palette dialog ──────────────────────────────────────────────── */

interface SectionItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string; // search corpus
  onSelect: () => void;
}

interface Section {
  heading: string;
  items: SectionItem[];
}

interface CommandPaletteDialogProps {
  open: boolean;
  setOpen: (next: boolean) => void;
  isAdmin: boolean;
}

function CommandPaletteDialog({
  open,
  setOpen,
  isAdmin,
}: CommandPaletteDialogProps): React.ReactElement | null {
  const router = useRouter();
  const { setTheme } = useTheme();
  const reduced = usePrefersReducedMotion();
  const [query, setQuery] = useState<string>("");

  // Reset query when closed.
  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const indexQuery = useQuery<SearchIndexResponse>({
    queryKey: ["search-index"],
    queryFn: fetchSearchIndex,
    enabled: open,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const go = useCallback(
    (href: string): void => {
      setOpen(false);
      router.push(href);
    },
    [router, setOpen],
  );

  const onSignOut = useCallback(async (): Promise<void> => {
    setOpen(false);
    try {
      await authClient.signOut();
    } catch {
      /* ignore — best-effort */
    }
    router.push("/login");
  }, [router, setOpen]);

  const data = indexQuery.data;

  const sections: Section[] = useMemo(() => {
    const out: Section[] = [];

    // ── Actions (admin-only) ───────────────────────────────
    if (isAdmin) {
      out.push({
        heading: "Actions",
        items: [
          {
            id: "action:create-monitor",
            label: "Create monitor",
            hint: "Open the monitor wizard",
            icon: Plus,
            value: "action create monitor new check",
            onSelect: (): void => go("/monitors?new=1"),
          },
          {
            id: "action:invite-user",
            label: "Invite user",
            hint: "Send an invitation to a new teammate",
            icon: UserPlus,
            value: "action invite user admin",
            onSelect: (): void => go("/admin/users?invite=1"),
          },
          {
            id: "action:theme-light",
            label: "Set theme: Light",
            hint: "Switch appearance to light",
            icon: Sun,
            value: "action theme light",
            onSelect: (): void => {
              setTheme("light");
              setOpen(false);
            },
          },
          {
            id: "action:theme-dark",
            label: "Set theme: Dark",
            hint: "Switch appearance to dark",
            icon: Moon,
            value: "action theme dark",
            onSelect: (): void => {
              setTheme("dark");
              setOpen(false);
            },
          },
          {
            id: "action:theme-system",
            label: "Set theme: System",
            hint: "Follow the operating-system theme",
            icon: Laptop,
            value: "action theme system",
            onSelect: (): void => {
              setTheme("system");
              setOpen(false);
            },
          },
          {
            id: "action:sign-out",
            label: "Sign out",
            hint: "End session and return to login",
            icon: LogOut,
            value: "action sign out logout",
            onSelect: (): void => {
              void onSignOut();
            },
          },
        ],
      });
    }

    // ── Navigation ────────────────────────────────────────
    const navItems: SectionItem[] = [
      {
        id: "nav:overview",
        label: "Overview",
        hint: "Dashboard",
        icon: LayoutDashboard,
        value: "nav overview dashboard home",
        onSelect: (): void => go("/dashboard"),
      },
      {
        id: "nav:monitors",
        label: "Monitors",
        hint: "All monitors & checks",
        icon: Radar,
        value: "nav monitors checks",
        onSelect: (): void => go("/monitors"),
      },
      {
        id: "nav:agents",
        label: "Agents",
        hint: "Connected agents",
        icon: Server,
        value: "nav agents",
        onSelect: (): void => go("/agents"),
      },
      {
        id: "nav:alerts",
        label: "Alerts",
        hint: "Incidents & rules",
        icon: Bell,
        value: "nav alerts incidents",
        onSelect: (): void => go("/alerts"),
      },
      {
        id: "nav:profile",
        label: "Profile",
        hint: "Your account",
        icon: User,
        value: "nav profile account me",
        onSelect: (): void => go("/profile"),
      },
    ];
    if (isAdmin) {
      navItems.push(
        {
          id: "nav:admin-users",
          label: "Admin \u00b7 Users",
          hint: "Manage team members",
          icon: Users,
          value: "nav admin users team",
          onSelect: (): void => go("/admin/users"),
        },
        {
          id: "nav:admin-audit",
          label: "Admin \u00b7 Audit",
          hint: "Security audit log",
          icon: FileText,
          value: "nav admin audit log security",
          onSelect: (): void => go("/admin/audit"),
        },
        {
          id: "nav:admin-system",
          label: "Admin \u00b7 System",
          hint: "Process / DB / queue metrics",
          icon: Activity,
          value: "nav admin system metrics queue db",
          onSelect: (): void => go("/admin/system"),
        },
      );
    }
    out.push({ heading: "Navigation", items: navItems });

    // ── Agents (from index) ──────────────────────────────
    if (data?.agents && data.agents.length > 0) {
      out.push({
        heading: "Agents",
        items: data.agents.slice(0, 15).map((a: SearchIndexAgent) => ({
          id: `agent:${a.id}`,
          label: a.name,
          hint: `Agent \u00b7 ${a.status}`,
          icon: Server,
          // include id in value to guarantee uniqueness across duplicate names.
          value: `agent ${a.name} ${a.status} ${a.id}`,
          onSelect: (): void => go(`/agents/${a.id}`),
        })),
      });
    }

    // ── Monitors (from index, top 15) ────────────────────
    if (data?.monitors && data.monitors.length > 0) {
      out.push({
        heading: "Monitors",
        items: data.monitors.slice(0, 15).map((m: SearchIndexMonitor) => ({
          id: `monitor:${m.kind}:${m.id}`,
          label: m.name,
          hint:
            m.agentName !== null && m.agentName.length > 0
              ? `${m.type} \u00b7 ${m.agentName}`
              : m.type,
          icon: Radar,
          value: `monitor ${m.name} ${m.type} ${m.agentName ?? ""} ${m.id}`,
          onSelect: (): void => go(`/monitors?focus=${encodeURIComponent(m.id)}`),
        })),
      });
    }

    // ── Incidents (only if non-empty) ────────────────────
    if (data?.incidents && data.incidents.length > 0) {
      out.push({
        heading: "Incidents",
        items: data.incidents.map((i: SearchIndexIncident) => ({
          id: `incident:${i.id}`,
          label: i.title,
          hint:
            i.agentName !== null && i.agentName.length > 0
              ? `${i.severity} \u00b7 ${i.agentName}`
              : i.severity,
          icon: AlertTriangle,
          value: `incident ${i.title} ${i.severity} ${i.agentName ?? ""} ${i.id}`,
          onSelect: (): void => go(`/alerts?focus=${encodeURIComponent(i.id)}`),
        })),
      });
    }

    return out;
  }, [data, go, isAdmin, onSignOut, setOpen, setTheme]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm",
            "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
            reduced ? "" : "transition-opacity duration-150",
          )}
        />
        <Dialog.Content
          aria-label="Command palette"
          className={cn(
            "fixed left-1/2 top-[20%] z-[81] w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2",
            "overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl",
            "dark:border-gray-800 dark:bg-gray-900",
            "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
            reduced ? "" : "transition-opacity duration-150",
          )}
          onOpenAutoFocus={(e): void => {
            // Let cmdk's Command.Input claim focus; prevent Radix default.
            e.preventDefault();
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search for agents, monitors, incidents, and actions. Use arrow keys
            to navigate and Enter to select.
          </Dialog.Description>

          <Command
            label="Command palette"
            shouldFilter
            className="flex flex-col"
          >
            <div className="flex items-center gap-2 border-b border-gray-200 px-4 dark:border-gray-800">
              <Search className="h-4 w-4 shrink-0 text-gray-400" />
              <Command.Input
                aria-label="Search agents, monitors, incidents, and actions"
                placeholder={"Type to search agents, monitors, incidents\u2026"}
                value={query}
                onValueChange={setQuery}
                className="flex h-12 w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
                autoFocus
              />
              <kbd className="hidden shrink-0 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 sm:inline-block">
                Esc
              </kbd>
            </div>

            <Command.List className="max-h-[400px] overflow-y-auto overflow-x-hidden p-2">
              <Command.Empty className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                {indexQuery.isLoading
                  ? "Loading\u2026"
                  : query.length === 0
                    ? "Type to search agents, monitors, incidents\u2026"
                    : "No results found."}
              </Command.Empty>

              {sections.map((section) => (
                <Command.Group
                  key={section.heading}
                  heading={section.heading}
                  className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
                >
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Command.Item
                        key={item.id}
                        value={item.value}
                        onSelect={(): void => item.onSelect()}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-700 dark:text-gray-200",
                          "aria-selected:bg-gray-100 aria-selected:text-gray-900",
                          "dark:aria-selected:bg-gray-800 dark:aria-selected:text-white",
                          "data-[selected=true]:bg-gray-100 data-[selected=true]:text-gray-900",
                          "dark:data-[selected=true]:bg-gray-800 dark:data-[selected=true]:text-white",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.hint !== undefined && item.hint.length > 0 ? (
                          <span className="shrink-0 truncate text-xs text-gray-400 dark:text-gray-500">
                            {item.hint}
                          </span>
                        ) : null}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ))}
            </Command.List>

            <div className="flex items-center justify-between border-t border-gray-200 px-4 py-2 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">
              <div className="flex items-center gap-1.5">
                <Shield className="h-3 w-3 text-emerald-500" />
                <span>Vigil</span>
              </div>
              <div>
                {"\u2191\u2193 to navigate \u00b7 \u21b5 to select \u00b7 Esc to close"}
              </div>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** ── Public mount component ──────────────────────────────────────── */

export function CommandPalette(): React.ReactElement | null {
  const { data: session } = useSession();
  const { open, setOpen } = useCommandPalette();
  const router = useRouter();
  const toast = useToast();
  const [gMode, setGMode] = useState<boolean>(false);

  const sessionUser = session?.user as
    | { role?: SessionRole; email?: string }
    | undefined;
  const isAdmin = sessionUser?.role === "admin";
  const isAuthed = !!sessionUser;

  useGPrefixHotkeys({
    isAdmin,
    onPrefixChange: setGMode,
    onNavigate: (href) => router.push(href),
  });

  // Show a transient info toast whenever we enter g-mode.
  const lastModeRef = useRef<boolean>(false);
  useEffect(() => {
    if (gMode && !lastModeRef.current) {
      toast.info("g mode", "Next key navigates: a/m/i/s/p/o");
    }
    lastModeRef.current = gMode;
  }, [gMode, toast]);

  // Only render the palette for authenticated users — it's useless otherwise
  // (everything inside it is app-internal) and avoids flashing for unauth users.
  if (!isAuthed) return null;

  return (
    <CommandPaletteDialog open={open} setOpen={setOpen} isAdmin={isAdmin} />
  );
}
