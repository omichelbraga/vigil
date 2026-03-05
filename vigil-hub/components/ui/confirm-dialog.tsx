"use client";
import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "info";
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

const VARIANT_STYLES = {
  danger: { btn: "bg-red-600 hover:bg-red-700 text-white", icon: "\uD83D\uDDD1\uFE0F", iconBg: "bg-red-100 dark:bg-red-900/30" },
  warning: { btn: "bg-amber-500 hover:bg-amber-600 text-white", icon: "\u26A0\uFE0F", iconBg: "bg-amber-100 dark:bg-amber-900/30" },
  info: { btn: "bg-emerald-600 hover:bg-emerald-700 text-white", icon: "\u2139\uFE0F", iconBg: "bg-blue-100 dark:bg-blue-900/30" },
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    open: boolean;
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      setState({ open: true, opts, resolve });
    });
  }, []);

  const handleConfirm = () => {
    state?.resolve(true);
    setState(null);
  };

  const handleCancel = () => {
    state?.resolve(false);
    setState(null);
  };

  const variant = state?.opts.variant ?? "danger";
  const styles = VARIANT_STYLES[variant];

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <Dialog.Root open={state?.open ?? false} onOpenChange={open => { if (!open) handleCancel(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900 focus:outline-none">
            <div className="flex items-start gap-4">
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl ${styles.iconBg}`}>
                {styles.icon}
              </div>
              <div className="flex-1">
                <Dialog.Title className="text-base font-semibold text-gray-900 dark:text-white">
                  {state?.opts.title}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {state?.opts.message}
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                onClick={handleCancel}
                className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {state?.opts.cancelLabel ?? "Cancel"}
              </button>
              <button
                onClick={handleConfirm}
                className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium ${styles.btn}`}
              >
                {state?.opts.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmProvider");
  return ctx.confirm;
}
