"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import { cn } from "@/lib/utils";
import type { NotificationPrefs, ProfileUser } from "./profile-types";

interface NotificationsTabProps {
  user: ProfileUser;
}

const inputClass =
  "rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white";

export function NotificationsTab({
  user,
}: NotificationsTabProps): React.ReactElement {
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();

  const initial: NotificationPrefs = user.notificationPrefs ?? {};
  const [incidentAssigned, setIncidentAssigned] = useState<boolean>(
    initial.incidentAssigned ?? true,
  );
  const [ownedCheckFailing, setOwnedCheckFailing] = useState<boolean>(
    initial.ownedCheckFailing ?? true,
  );
  const [digest, setDigest] = useState<NonNullable<NotificationPrefs["digest"]>>(
    initial.digest ?? "off",
  );

  useEffect(() => {
    const p = user.notificationPrefs ?? {};
    setIncidentAssigned(p.incidentAssigned ?? true);
    setOwnedCheckFailing(p.ownedCheckFailing ?? true);
    setDigest(p.digest ?? "off");
  }, [user]);

  const mutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const body = {
        notificationPrefs: {
          incidentAssigned,
          ownedCheckFailing,
          digest,
        } satisfies NotificationPrefs,
      };
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Save failed");
    },
    onSuccess: () => {
      success("Notification preferences saved");
      void qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Save failed";
      toastError("Could not save", message);
    },
  });

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Email notifications
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Email delivered to{" "}
          <span className="font-mono">{user.email}</span>.
        </p>

        <div className="mt-5 space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={incidentAssigned}
              onChange={(e) => setIncidentAssigned(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-600"
            />
            <div>
              <span className="text-sm font-medium text-gray-900 dark:text-white">
                An incident is assigned to me
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Immediate email when someone (or a rule) assigns you an incident.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={ownedCheckFailing}
              onChange={(e) => setOwnedCheckFailing(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-600"
            />
            <div>
              <span className="text-sm font-medium text-gray-900 dark:text-white">
                A check I own starts failing
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Triggered when any of your owned checks transitions to warning or
                critical.
              </p>
            </div>
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Daily digest
            </label>
            <select
              value={digest}
              onChange={(e) =>
                setDigest(e.target.value as NonNullable<NotificationPrefs["digest"]>)
              }
              className={cn(inputClass, "mt-1 w-48")}
            >
              <option value="off">Off</option>
              <option value="morning">Morning (8am local)</option>
              <option value="evening">Evening (6pm local)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              A short summary of everything that changed in the last 24 hours.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            <Save />
            {mutation.isPending ? "Saving…" : "Save preferences"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
          <MessageSquare className="h-5 w-5 text-gray-400" />
          Slack / Teams direct messages
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Configure at org level — available in a future release.
        </p>
      </div>
    </div>
  );
}
