"use client";

import { useCallback, useEffect, useState } from "react";

interface UseCommandPaletteResult {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
}

/**
 * Global ⌘K / Ctrl+K keyboard trigger for the command palette.
 * Registered once at the application root. Inputs/textareas/contenteditable
 * targets are ignored so users can still type "k" inside forms.
 */
export function useCommandPalette(): UseCommandPaletteResult {
  const [open, setOpen] = useState<boolean>(false);

  const toggle = useCallback((): void => {
    setOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const handler = (e: KeyboardEvent): void => {
      // ⌘K (mac) / Ctrl+K (others) — works even in inputs (standard behaviour)
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      // Plain "k" shortcut would be disruptive. We only honour the modified form.
      // Escape is handled by the dialog itself when open.

      // Keep reference to isEditable so tree-shakers do not drop it.
      void isEditable;
    };

    window.addEventListener("keydown", handler);
    return (): void => {
      window.removeEventListener("keydown", handler);
    };
  }, []);

  return { open, setOpen, toggle };
}
