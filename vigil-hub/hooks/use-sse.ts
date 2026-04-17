"use client";

import { useEffect, useRef } from "react";

export type SseEventHandler = (event: string, data: unknown) => void;

interface UseSseOptions {
  url?: string;
  enabled?: boolean;
  events?: string[];
  onEvent: SseEventHandler;
}

/**
 * Subscribe to an SSE endpoint and dispatch typed events.
 * - `events` narrows which named events are forwarded (empty = all).
 * - `onEvent` receives `(eventName, parsedData)`.
 * - The connection is torn down on unmount or when `enabled` flips to false.
 */
export function useSse({ url = "/api/sse", enabled = true, events, onEvent }: UseSseOptions): void {
  const handlerRef = useRef<SseEventHandler>(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource(url);
    const listeners: Array<{ name: string; fn: (e: MessageEvent<string>) => void }> = [];

    // If caller specified named events, add a listener per event.
    // Otherwise attach to `message` (default unnamed events).
    const attach = (name: string): void => {
      const fn = (e: MessageEvent<string>): void => {
        let parsed: unknown = e.data;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          // keep raw string
        }
        handlerRef.current(name, parsed);
      };
      es.addEventListener(name, fn as EventListener);
      listeners.push({ name, fn });
    };

    if (events && events.length > 0) {
      for (const name of events) attach(name);
    } else {
      attach("message");
    }

    es.onerror = (): void => {
      // Let the browser's automatic reconnection handle transient failures.
      // If the server returned 401, EventSource will keep retrying — we rely on
      // the user being authenticated to reach this page at all.
    };

    return () => {
      for (const l of listeners) {
        try {
          es.removeEventListener(l.name, l.fn as EventListener);
        } catch {
          // ignore
        }
      }
      es.close();
    };
  }, [url, enabled, events]);
}
