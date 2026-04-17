"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { cn } from "@/lib/utils";
import {
  COMMON_TIMEZONES,
  LOCALES,
  type ProfileUser,
} from "./profile-types";

interface GeneralTabProps {
  user: ProfileUser;
}

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500";
const labelClass =
  "block text-sm font-medium text-gray-700 dark:text-gray-300";

function getRuntimeTimezones(): string[] {
  // Intl.supportedValuesOf is available in modern runtimes (Node 18.13+, all
  // evergreen browsers). Fall back to a curated list if it's missing.
  const maybe = (Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  }).supportedValuesOf;
  if (typeof maybe === "function") {
    try {
      return maybe("timeZone");
    } catch {
      return COMMON_TIMEZONES;
    }
  }
  return COMMON_TIMEZONES;
}

export function GeneralTab({ user }: GeneralTabProps): React.ReactElement {
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();

  const [name, setName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [timezone, setTimezone] = useState(user.timezone ?? "UTC");
  const [locale, setLocale] = useState(user.locale ?? "en");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [timezones, setTimezones] = useState<string[]>(COMMON_TIMEZONES);

  useEffect(() => {
    setTimezones(getRuntimeTimezones());
  }, []);

  useEffect(() => {
    setName(user.name);
    setAvatarUrl(user.avatarUrl ?? "");
    setTimezone(user.timezone ?? "UTC");
    setLocale(user.locale ?? "en");
  }, [user]);

  const mutation = useMutation({
    mutationFn: async (): Promise<ProfileUser> => {
      const body: Record<string, unknown> = {
        name,
        timezone,
        locale,
        avatarUrl: avatarUrl.trim().length === 0 ? null : avatarUrl.trim(),
      };
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as
        | ProfileUser
        | { error: string; fieldErrors?: Record<string, string> };
      if (!res.ok) {
        if ("fieldErrors" in data && data.fieldErrors) {
          setFieldErrors(data.fieldErrors);
        }
        throw new Error(("error" in data ? data.error : null) || "Save failed");
      }
      return data as ProfileUser;
    },
    onSuccess: () => {
      setFieldErrors({});
      success("Profile saved");
      void qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Save failed";
      toastError("Could not save", message);
    },
  });

  const nameError =
    name.trim().length === 0 ? "Name is required" : fieldErrors.name;
  const avatarError =
    avatarUrl.trim().length > 0 && !/^https:\/\//i.test(avatarUrl.trim())
      ? "Must start with https://"
      : fieldErrors.avatarUrl;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
        General
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Update your public profile details.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[160px_1fr]">
        <div className="flex flex-col items-center gap-3">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Avatar preview"
              className="h-24 w-24 rounded-full object-cover ring-2 ring-emerald-500/20"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-600 text-3xl font-semibold text-white">
              {(name[0] || user.email[0] || "U").toUpperCase()}
            </div>
          )}
          <p className="text-center text-xs text-gray-500 dark:text-gray-400">
            Paste an https URL below to update your avatar.
          </p>
        </div>

        <div className="space-y-5">
          <div>
            <label className={labelClass}>Avatar URL</label>
            <input
              type="url"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://example.com/me.png"
              className={cn(inputClass, "mt-1")}
            />
            {avatarError ? (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                {avatarError}
              </p>
            ) : null}
          </div>

          <div>
            <label className={labelClass}>Display name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn(inputClass, "mt-1")}
            />
            {nameError ? (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                {nameError}
              </p>
            ) : null}
          </div>

          <div>
            <label className={labelClass}>Email</label>
            <input
              type="email"
              value={user.email}
              readOnly
              className={cn(
                inputClass,
                "mt-1 cursor-not-allowed bg-gray-50 text-gray-500 dark:bg-gray-800/40",
              )}
            />
            <p className="mt-1 text-xs text-gray-400">
              Email address changes are not supported in this release.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className={cn(inputClass, "mt-1")}
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              {fieldErrors.timezone ? (
                <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                  {fieldErrors.timezone}
                </p>
              ) : null}
            </div>
            <div>
              <label className={labelClass}>Locale</label>
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                className={cn(inputClass, "mt-1")}
              >
                {LOCALES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !!nameError || !!avatarError}
            >
              <Save />
              {mutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
