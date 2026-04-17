"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ShieldCheck,
  KeyRound,
  Loader2,
  AlertTriangle,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast-provider";
import { cn } from "@/lib/utils";
import type { TwoFactorStatus } from "./profile-types";

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500";
const labelClass =
  "block text-sm font-medium text-gray-700 dark:text-gray-300";

/** Build a Google Chart QR URL for the otpauth:// URI (no external deps). */
function qrUrl(otpauthUri: string): string {
  const encoded = encodeURIComponent(otpauthUri);
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encoded}`;
}

function PasswordSection(): React.ReactElement {
  const { success, error: toastError } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const mutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch("/api/profile/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Password change failed");
    },
    onSuccess: () => {
      success("Password updated");
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Password change failed";
      toastError("Could not update password", message);
    },
  });

  const mismatch = confirm.length > 0 && confirm !== next;
  const tooShort = next.length > 0 && next.length < 8;
  const disabled =
    mutation.isPending ||
    current.length === 0 ||
    next.length < 8 ||
    confirm !== next;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <h3 className="text-base font-semibold text-gray-900 dark:text-white">
        Change password
      </h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Confirm your current password, then choose a new one (minimum 8 characters).
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <div>
          <label className={labelClass}>Current password</label>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className={cn(inputClass, "mt-1")}
          />
        </div>
        <div>
          <label className={labelClass}>New password</label>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            className={cn(inputClass, "mt-1")}
          />
          {tooShort ? (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
              Must be at least 8 characters.
            </p>
          ) : null}
        </div>
        <div>
          <label className={labelClass}>Confirm</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className={cn(inputClass, "mt-1")}
          />
          {mismatch ? (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
              Passwords do not match.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-5">
        <Button onClick={() => mutation.mutate()} disabled={disabled}>
          <KeyRound />
          {mutation.isPending ? "Updating…" : "Update password"}
        </Button>
      </div>
    </div>
  );
}

interface BackupCodesModalProps {
  codes: string[];
  onAcknowledged: () => void;
}

function BackupCodesModal({
  codes,
  onAcknowledged,
}: BackupCodesModalProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const { success } = useToast();
  const text = codes.join("\n");

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onAcknowledged(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl",
            "dark:bg-gray-900 focus:outline-none",
          )}
        >
          <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Save your backup codes
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Store these in a safe place. Each code can be used once if you lose access
            to your authenticator app. They will never be shown again.
          </Dialog.Description>

          <pre className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-sm dark:border-gray-700 dark:bg-gray-950">
            {codes.map((c) => (
              <code key={c} className="text-gray-800 dark:text-gray-200">
                {c}
              </code>
            ))}
          </pre>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-between">
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setCopied(true);
                  success("Copied to clipboard");
                  window.setTimeout(() => setCopied(false), 2000);
                } catch {
                  /* ignore clipboard failures */
                }
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy all"}
            </Button>
            <Button onClick={onAcknowledged}>I&apos;ve saved them</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface EnableDialogState {
  open: boolean;
  step: "password" | "verify";
  password: string;
  totpUri: string;
  backupCodes: string[];
  totpCode: string;
  submitting: boolean;
}

interface DisableDialogState {
  open: boolean;
  password: string;
  submitting: boolean;
}

function TwoFactorSection(): React.ReactElement {
  const qc = useQueryClient();
  const { success, error: toastError } = useToast();
  const [enable, setEnable] = useState<EnableDialogState>({
    open: false,
    step: "password",
    password: "",
    totpUri: "",
    backupCodes: [],
    totpCode: "",
    submitting: false,
  });
  const [disable, setDisable] = useState<DisableDialogState>({
    open: false,
    password: "",
    submitting: false,
  });
  const [pendingBackupCodes, setPendingBackupCodes] = useState<string[] | null>(null);
  const [regenPassword, setRegenPassword] = useState<string>("");
  const [regenOpen, setRegenOpen] = useState<boolean>(false);
  const [regenSubmitting, setRegenSubmitting] = useState<boolean>(false);

  const status = useQuery({
    queryKey: ["profile", "2fa-status"],
    queryFn: async (): Promise<TwoFactorStatus> => {
      const res = await fetch("/api/profile/2fa/status");
      if (!res.ok) throw new Error("Failed to load 2FA status");
      return (await res.json()) as TwoFactorStatus;
    },
  });

  const enabled = status.data?.enabled === true;

  const submitEnableStep1 = async (): Promise<void> => {
    setEnable((s) => ({ ...s, submitting: true }));
    try {
      const res = await fetch("/api/profile/2fa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: enable.password }),
      });
      const data = (await res.json()) as
        | { totpURI: string; backupCodes: string[] }
        | { error: string };
      if (!res.ok || !("totpURI" in data)) {
        throw new Error(("error" in data ? data.error : null) || "Failed");
      }
      setEnable((s) => ({
        ...s,
        step: "verify",
        totpUri: data.totpURI,
        backupCodes: data.backupCodes,
        submitting: false,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed";
      toastError("Could not start 2FA setup", message);
      setEnable((s) => ({ ...s, submitting: false }));
    }
  };

  const submitEnableStep2 = async (): Promise<void> => {
    setEnable((s) => ({ ...s, submitting: true }));
    try {
      const res = await fetch("/api/profile/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totpCode: enable.totpCode }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Invalid code");
      success("Two-factor authentication enabled");
      setPendingBackupCodes(enable.backupCodes);
      setEnable({
        open: false,
        step: "password",
        password: "",
        totpUri: "",
        backupCodes: [],
        totpCode: "",
        submitting: false,
      });
      void qc.invalidateQueries({ queryKey: ["profile"] });
      void qc.invalidateQueries({ queryKey: ["profile", "2fa-status"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid code";
      toastError("Verification failed", message);
      setEnable((s) => ({ ...s, submitting: false }));
    }
  };

  const submitDisable = async (): Promise<void> => {
    setDisable((s) => ({ ...s, submitting: true }));
    try {
      const res = await fetch("/api/profile/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: disable.password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed");
      success("Two-factor authentication disabled");
      setDisable({ open: false, password: "", submitting: false });
      void qc.invalidateQueries({ queryKey: ["profile"] });
      void qc.invalidateQueries({ queryKey: ["profile", "2fa-status"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed";
      toastError("Could not disable 2FA", message);
      setDisable((s) => ({ ...s, submitting: false }));
    }
  };

  const submitRegen = async (): Promise<void> => {
    setRegenSubmitting(true);
    try {
      const res = await fetch("/api/profile/2fa/backup-codes/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: regenPassword }),
      });
      const data = (await res.json()) as
        | { backupCodes: string[] }
        | { error: string };
      if (!res.ok || !("backupCodes" in data)) {
        throw new Error(("error" in data ? data.error : null) || "Failed");
      }
      setPendingBackupCodes(data.backupCodes);
      setRegenOpen(false);
      setRegenPassword("");
      void qc.invalidateQueries({ queryKey: ["profile", "2fa-status"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed";
      toastError("Could not regenerate codes", message);
    } finally {
      setRegenSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <ShieldCheck className="h-5 w-5 text-emerald-500" />
            Two-factor authentication
            {enabled ? (
              <Badge variant="ok">Enabled</Badge>
            ) : (
              <Badge variant="muted">Disabled</Badge>
            )}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Protect your account with a time-based one-time password (TOTP) from an
            authenticator app.
          </p>
          {enabled ? (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Backup codes remaining:{" "}
              <span className="font-mono text-gray-700 dark:text-gray-200">
                {status.data?.backupCodesRemaining ?? "–"}
              </span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          {enabled ? (
            <>
              <Button
                variant="destructive"
                onClick={() => setDisable({ open: true, password: "", submitting: false })}
              >
                Disable 2FA
              </Button>
              <Button variant="outline" onClick={() => setRegenOpen(true)}>
                Regenerate backup codes
              </Button>
            </>
          ) : (
            <Button
              onClick={() =>
                setEnable({
                  open: true,
                  step: "password",
                  password: "",
                  totpUri: "",
                  backupCodes: [],
                  totpCode: "",
                  submitting: false,
                })
              }
            >
              Enable 2FA
            </Button>
          )}
        </div>
      </div>

      {/* Enable dialog */}
      <Dialog.Root
        open={enable.open}
        onOpenChange={(o) => {
          if (!o && !enable.submitting) {
            setEnable((s) => ({ ...s, open: false }));
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
            <Dialog.Title className="text-base font-semibold text-gray-900 dark:text-white">
              {enable.step === "password"
                ? "Confirm password to enable 2FA"
                : "Scan the QR code and enter the 6-digit code"}
            </Dialog.Title>
            {enable.step === "password" ? (
              <div className="mt-4 space-y-4">
                <input
                  type="password"
                  placeholder="Current password"
                  value={enable.password}
                  onChange={(e) =>
                    setEnable((s) => ({ ...s, password: e.target.value }))
                  }
                  className={inputClass}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEnable((s) => ({ ...s, open: false }))}
                    disabled={enable.submitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={submitEnableStep1}
                    disabled={enable.submitting || enable.password.length === 0}
                  >
                    {enable.submitting ? <Loader2 className="animate-spin" /> : null}
                    Continue
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="flex flex-col items-center gap-3">
                  <img
                    src={qrUrl(enable.totpUri)}
                    alt="TOTP QR code"
                    className="h-52 w-52 rounded-lg bg-white p-2"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Or use this URI manually:
                  </p>
                  <code className="max-w-full overflow-x-auto rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
                    {enable.totpUri}
                  </code>
                </div>
                <div>
                  <label className={labelClass}>6-digit code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={enable.totpCode}
                    onChange={(e) =>
                      setEnable((s) => ({
                        ...s,
                        totpCode: e.target.value.replace(/\D/g, "").slice(0, 6),
                      }))
                    }
                    className={cn(inputClass, "mt-1 font-mono text-center tracking-widest")}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEnable((s) => ({ ...s, open: false }))}
                    disabled={enable.submitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={submitEnableStep2}
                    disabled={enable.submitting || enable.totpCode.length !== 6}
                  >
                    {enable.submitting ? <Loader2 className="animate-spin" /> : null}
                    Verify &amp; enable
                  </Button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Disable dialog */}
      <Dialog.Root
        open={disable.open}
        onOpenChange={(o) => {
          if (!o && !disable.submitting) {
            setDisable({ open: false, password: "", submitting: false });
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
            <Dialog.Title className="text-base font-semibold text-gray-900 dark:text-white">
              Disable two-factor authentication
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Confirm your password to turn off 2FA. You can re-enable it at any time.
            </Dialog.Description>
            <div className="mt-4 space-y-4">
              <input
                type="password"
                placeholder="Current password"
                value={disable.password}
                onChange={(e) =>
                  setDisable((s) => ({ ...s, password: e.target.value }))
                }
                className={inputClass}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    setDisable({ open: false, password: "", submitting: false })
                  }
                  disabled={disable.submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={submitDisable}
                  disabled={disable.submitting || disable.password.length === 0}
                >
                  {disable.submitting ? <Loader2 className="animate-spin" /> : null}
                  Disable
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Regenerate dialog */}
      <Dialog.Root
        open={regenOpen}
        onOpenChange={(o) => {
          if (!o && !regenSubmitting) {
            setRegenOpen(false);
            setRegenPassword("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
            <Dialog.Title className="text-base font-semibold text-gray-900 dark:text-white">
              Regenerate backup codes
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Generates a fresh set of one-time backup codes. Any previously issued
              codes will stop working.
            </Dialog.Description>
            <div className="mt-4 space-y-4">
              <input
                type="password"
                placeholder="Current password"
                value={regenPassword}
                onChange={(e) => setRegenPassword(e.target.value)}
                className={inputClass}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setRegenOpen(false);
                    setRegenPassword("");
                  }}
                  disabled={regenSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitRegen}
                  disabled={regenSubmitting || regenPassword.length === 0}
                >
                  {regenSubmitting ? <Loader2 className="animate-spin" /> : null}
                  Regenerate
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Backup codes display (post-enable or post-regenerate) */}
      {pendingBackupCodes ? (
        <BackupCodesModal
          codes={pendingBackupCodes}
          onAcknowledged={() => setPendingBackupCodes(null)}
        />
      ) : null}
    </div>
  );
}

export function SecurityTab(): React.ReactElement {
  return (
    <div className="space-y-6">
      <PasswordSection />
      <TwoFactorSection />
    </div>
  );
}
