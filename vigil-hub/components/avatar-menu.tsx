"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { User, LogOut, Monitor, Moon, Sun, ChevronDown } from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type ThemeChoice = "light" | "dark" | "system";

interface AvatarMenuProps {
  avatarUrl?: string | null;
}

export function AvatarMenu({ avatarUrl }: AvatarMenuProps): React.ReactElement | null {
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState<boolean>(false);
  const [themeSubOpen, setThemeSubOpen] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setThemeSubOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setThemeSubOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!session?.user) return null;
  const email = session.user.email || "";
  const name = session.user.name || email;
  const initial = (name[0] || email[0] || "U").toUpperCase();

  const handleSignOut = async (): Promise<void> => {
    await signOut();
    window.location.href = "/login";
  };

  const selectTheme = (value: ThemeChoice): void => {
    setTheme(value);
    setThemeSubOpen(false);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-2 rounded-full p-1 pr-2 transition-colors",
          "hover:bg-gray-100 dark:hover:bg-gray-800",
        )}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={name}
            className="h-8 w-8 rounded-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white">
            {initial}
          </span>
        )}
        <ChevronDown className="h-4 w-4 text-gray-500 dark:text-gray-400" />
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl",
            "dark:border-gray-800 dark:bg-gray-900",
          )}
        >
          <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
            <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
              {name}
            </p>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">{email}</p>
          </div>

          <div className="py-1">
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <User className="h-4 w-4" />
              Profile
            </Link>

            <button
              type="button"
              role="menuitem"
              onClick={() => setThemeSubOpen((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {theme === "dark" ? (
                <Moon className="h-4 w-4" />
              ) : theme === "light" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Monitor className="h-4 w-4" />
              )}
              Theme
              <span className="ml-auto text-xs text-gray-400">
                {theme ?? "system"}
              </span>
            </button>
            {themeSubOpen ? (
              <div className="border-y border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-950/40">
                {(["light", "dark", "system"] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme === opt}
                    onClick={() => selectTheme(opt)}
                    className={cn(
                      "flex w-full items-center gap-2 px-6 py-2 text-left text-xs",
                      theme === opt
                        ? "font-semibold text-emerald-600 dark:text-emerald-400"
                        : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800",
                    )}
                  >
                    {opt === "light" ? (
                      <Sun className="h-3.5 w-3.5" />
                    ) : opt === "dark" ? (
                      <Moon className="h-3.5 w-3.5" />
                    ) : (
                      <Monitor className="h-3.5 w-3.5" />
                    )}
                    <span className="capitalize">{opt}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="border-t border-gray-100 py-1 dark:border-gray-800">
            <button
              type="button"
              role="menuitem"
              onClick={handleSignOut}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
