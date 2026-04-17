"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import {
  UserRound,
  ShieldCheck,
  MonitorSmartphone,
  KeyRound,
  Bell,
  AlertTriangle,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth-client";
import { GeneralTab } from "./general-tab";
import { SecurityTab } from "./security-tab";
import { SessionsTab } from "./sessions-tab";
import { ApiKeysTab } from "./api-keys-tab";
import { NotificationsTab } from "./notifications-tab";
import type { ProfileUser } from "./profile-types";

const TABS = [
  { value: "general", label: "General", icon: UserRound },
  { value: "security", label: "Security", icon: ShieldCheck },
  { value: "sessions", label: "Sessions", icon: MonitorSmartphone },
  { value: "api-keys", label: "API Keys", icon: KeyRound },
  { value: "notifications", label: "Notifications", icon: Bell },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default function ProfilePage(): React.ReactElement {
  const router = useRouter();
  const { data: session, isPending: sessionLoading } = useSession();
  const [tab, setTab] = useState<TabValue>("general");

  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: async (): Promise<ProfileUser> => {
      const res = await fetch("/api/profile");
      if (res.status === 401) {
        router.replace("/login?callbackUrl=/profile");
        throw new Error("Unauthorized");
      }
      if (!res.ok) throw new Error("Failed to load profile");
      return (await res.json()) as ProfileUser;
    },
    enabled: !!session?.user,
  });

  if (sessionLoading || profile.isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-7 w-32" />
          <Skeleton className="mt-2 h-4 w-60" />
        </div>
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  if (profile.isError || !profile.data) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5" />
          <p className="font-medium">Could not load profile.</p>
        </div>
        <p className="mt-1 text-sm">
          {profile.error instanceof Error
            ? profile.error.message
            : "Please refresh and try again."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Profile
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Manage your account, security, devices, API keys, and notifications.
        </p>
      </div>

      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(v as TabValue)}
        className="grid gap-6 lg:grid-cols-[220px_1fr]"
      >
        <Tabs.List
          aria-label="Profile sections"
          className={cn(
            "flex h-fit flex-row gap-1 overflow-x-auto rounded-lg bg-gray-100 p-1 dark:bg-gray-800",
            "lg:flex-col lg:overflow-visible lg:bg-transparent lg:p-0 lg:dark:bg-transparent",
          )}
        >
          {TABS.map((t) => {
            const active = tab === t.value;
            return (
              <Tabs.Trigger
                key={t.value}
                value={t.value}
                className={cn(
                  "inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  "lg:justify-start",
                  active
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white lg:bg-emerald-50 lg:text-emerald-700 lg:shadow-none lg:dark:bg-emerald-950/40 lg:dark:text-emerald-300"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 lg:hover:bg-gray-100 lg:dark:hover:bg-gray-800",
                )}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>

        <div className="min-w-0">
          <Tabs.Content value="general" className="outline-none">
            <GeneralTab user={profile.data} />
          </Tabs.Content>
          <Tabs.Content value="security" className="outline-none">
            <SecurityTab />
          </Tabs.Content>
          <Tabs.Content value="sessions" className="outline-none">
            <SessionsTab />
          </Tabs.Content>
          <Tabs.Content value="api-keys" className="outline-none">
            <ApiKeysTab />
          </Tabs.Content>
          <Tabs.Content value="notifications" className="outline-none">
            <NotificationsTab user={profile.data} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  );
}
