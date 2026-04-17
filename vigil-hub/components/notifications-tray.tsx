"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, Check, ExternalLink } from "lucide-react";
import { useSse } from "@/hooks/use-sse";
import {
  classifyEvent,
  TRAY_EVENT_NAMES,
  type TrayEvent,
  type TraySeverity,
} from "@/lib/notification-events";
import { cn } from "@/lib/utils";

const BUFFER_CAPACITY = 25;
const LS_LAST_READ = "vigil.tray.lastReadAt";
const LS_MUTED_UNTIL = "vigil.tray.mutedUntil";
const MUTE_DURATION_MS = 60 * 60 * 1000; // 1 hour

function readLocal(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Quota / private mode / ITP — tray still works without persistence.
  }
}

function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = Math.max(0, now - then);
  const s = Math.round(diffMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function severityDotClass(sev: TraySeverity): string {
  switch (sev) {
    case "crit":
      return "bg-rose-500";
    case "warn":
      return "bg-amber-500";
    case "info":
      return "bg-sky-500";
  }
}

/** Worst-severity wins for the top-right dot. */
function worstSeverity(events: readonly TrayEvent[]): TraySeverity | null {
  if (events.length === 0) return null;
  const order: Record<TraySeverity, number> = { crit: 3, warn: 2, info: 1 };
  let best: TraySeverity | null = null;
  for (const e of events) {
    if (best === null || order[e.severity] > order[best]) best = e.severity;
  }
  return best;
}

export function NotificationsTray(): React.ReactElement {
  const [events, setEvents] = useState<TrayEvent[]>([]);
  const [open, setOpen] = useState<boolean>(false);
  const [lastReadAt, setLastReadAt] = useState<string | null>(() =>
    readLocal(LS_LAST_READ),
  );
  const [mutedUntil, setMutedUntil] = useState<string | null>(() =>
    readLocal(LS_MUTED_UNTIL),
  );
  // Rerender-only tick — drives relative-time labels without touching buffer.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Ring-buffer: push newest, cap at BUFFER_CAPACITY.
  const pushEvent = useCallback((ev: TrayEvent) => {
    setEvents((prev) => {
      const next = [ev, ...prev];
      if (next.length > BUFFER_CAPACITY) next.length = BUFFER_CAPACITY;
      return next;
    });
  }, []);

  useSse({
    url: "/api/sse",
    enabled: true,
    events: TRAY_EVENT_NAMES.slice(),
    onEvent: (name, data) => {
      const classified = classifyEvent(name, data);
      if (classified) pushEvent(classified);
    },
  });

  // 1s tick to keep "3s ago" fresh. Uses setInterval, not rAF — budget-friendly.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Auto-clear mute when the window expires.
  useEffect(() => {
    if (!mutedUntil) return;
    const expires = Date.parse(mutedUntil);
    if (Number.isNaN(expires)) {
      setMutedUntil(null);
      writeLocal(LS_MUTED_UNTIL, null);
      return;
    }
    if (expires <= nowTick) {
      setMutedUntil(null);
      writeLocal(LS_MUTED_UNTIL, null);
    }
  }, [mutedUntil, nowTick]);

  const isMuted = useMemo<boolean>(() => {
    if (!mutedUntil) return false;
    const t = Date.parse(mutedUntil);
    return !Number.isNaN(t) && t > nowTick;
  }, [mutedUntil, nowTick]);

  const unreadEvents = useMemo<TrayEvent[]>(() => {
    const threshold = lastReadAt ? Date.parse(lastReadAt) : 0;
    if (Number.isNaN(threshold)) return events;
    return events.filter((e) => Date.parse(e.receivedAt) > threshold);
  }, [events, lastReadAt]);

  const unreadCount = unreadEvents.length;
  const badgeSeverity: TraySeverity | null = useMemo(
    () => (isMuted ? null : worstSeverity(unreadEvents)),
    [isMuted, unreadEvents],
  );

  // Outside-click + Escape handlers for the popover.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        // Restore focus to the trigger for good keyboard UX.
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // When opening, remember what had focus so we can return to it on close.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
    } else if (lastFocusedRef.current) {
      // Only return focus if nothing else has stolen it since.
      if (document.activeElement === document.body) {
        lastFocusedRef.current.focus?.();
      }
      lastFocusedRef.current = null;
    }
  }, [open]);

  const markAllRead = useCallback(() => {
    const now = new Date().toISOString();
    setLastReadAt(now);
    writeLocal(LS_LAST_READ, now);
  }, []);

  const toggleMute = useCallback(() => {
    if (isMuted) {
      setMutedUntil(null);
      writeLocal(LS_MUTED_UNTIL, null);
    } else {
      const until = new Date(Date.now() + MUTE_DURATION_MS).toISOString();
      setMutedUntil(until);
      writeLocal(LS_MUTED_UNTIL, until);
    }
  }, [isMuted]);

  const handleRowClick = useCallback(() => {
    // Marking read on navigate gives a sensible "I saw these" signal.
    markAllRead();
    setOpen(false);
  }, [markAllRead]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          unreadCount > 0
            ? `Notifications: ${unreadCount} unread`
            : "Notifications"
        }
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors",
          "text-gray-500 hover:bg-gray-100 hover:text-gray-700",
          "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2",
          "focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900",
        )}
      >
        {isMuted ? (
          <BellOff className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Bell className="h-5 w-5" aria-hidden="true" />
        )}
        {badgeSeverity ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute right-1.5 top-1.5 block h-2 w-2 rounded-full ring-2 ring-white dark:ring-gray-900",
              severityDotClass(badgeSeverity),
            )}
          />
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          aria-modal={false}
          className={cn(
            "absolute right-0 z-50 mt-2 w-[22rem] origin-top-right overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl",
            "dark:border-gray-800 dark:bg-gray-900",
            // Respect prefers-reduced-motion — only fade/scale when allowed.
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
            <div className="text-sm font-medium text-gray-900 dark:text-white">
              {unreadCount > 0 ? `${unreadCount} new` : "All caught up"}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={markAllRead}
                disabled={unreadCount === 0}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  "text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40",
                  "dark:text-gray-300 dark:hover:bg-gray-800",
                )}
                title="Mark all as read"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Mark all read
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={isMuted}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  isMuted
                    ? "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800",
                )}
                title={isMuted ? "Unmute notifications" : "Mute for 1 hour"}
              >
                {isMuted ? (
                  <>
                    <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
                    Muted
                  </>
                ) : (
                  <>
                    <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                    Mute 1h
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[26rem] overflow-y-auto">
            {events.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <Bell
                  className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600"
                  aria-hidden="true"
                />
                <p className="mt-3 text-sm font-medium text-gray-700 dark:text-gray-300">
                  No notifications yet
                </p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Real-time alerts and agent events will appear here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {events.map((ev) => {
                  const threshold = lastReadAt ? Date.parse(lastReadAt) : 0;
                  const isUnread =
                    !Number.isNaN(threshold) &&
                    Date.parse(ev.receivedAt) > threshold;
                  const row = (
                    <div
                      className={cn(
                        "flex gap-3 px-4 py-3 text-left transition-colors",
                        "hover:bg-gray-50 dark:hover:bg-gray-800/60",
                        isUnread ? "bg-emerald-50/30 dark:bg-emerald-950/10" : "",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                          severityDotClass(ev.severity),
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {ev.title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-gray-600 dark:text-gray-400">
                          {ev.subtitle}
                        </p>
                        <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                          {relativeTime(ev.receivedAt, nowTick)}
                        </p>
                      </div>
                      {ev.navHref ? (
                        <ExternalLink
                          className="h-3.5 w-3.5 shrink-0 self-center text-gray-300 dark:text-gray-600"
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                  );
                  return (
                    <li key={ev.id}>
                      {ev.navHref ? (
                        <Link
                          href={ev.navHref}
                          onClick={handleRowClick}
                          className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
                        >
                          {row}
                        </Link>
                      ) : (
                        <div>{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-100 bg-gray-50 px-4 py-2.5 text-center dark:border-gray-800 dark:bg-gray-950/40">
            <Link
              href="/alerts"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
            >
              View all alerts
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
