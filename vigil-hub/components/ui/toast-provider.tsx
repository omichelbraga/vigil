"use client";
import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { createPortal } from "react-dom";

export type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastContextValue {
  toast: (opts: { type: ToastType; title: string; message?: string }) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS = {
  success: "\u2705",
  error: "\u274C",
  info: "\u2139\uFE0F",
  warning: "\u26A0\uFE0F",
};

const COLORS = {
  success: "border-l-emerald-500 bg-white dark:bg-gray-900",
  error: "border-l-red-500 bg-white dark:bg-gray-900",
  info: "border-l-blue-500 bg-white dark:bg-gray-900",
  warning: "border-l-amber-500 bg-white dark:bg-gray-900",
};

const TITLE_COLORS = {
  success: "text-emerald-700 dark:text-emerald-400",
  error: "text-red-700 dark:text-red-400",
  info: "text-blue-700 dark:text-blue-400",
  warning: "text-amber-700 dark:text-amber-400",
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), 10);
    const hide = setTimeout(() => { setVisible(false); setTimeout(() => onRemove(toast.id), 300); }, 4000);
    return () => { clearTimeout(show); clearTimeout(hide); };
  }, [toast.id, onRemove]);

  return (
    <div
      className={`flex items-start gap-3 rounded-xl border border-gray-200 border-l-4 px-4 py-3 shadow-xl transition-all duration-300 w-80 ${COLORS[toast.type]} ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}
    >
      <span className="text-lg leading-none mt-0.5">{ICONS[toast.type]}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${TITLE_COLORS[toast.type]}`}>{toast.title}</p>
        {toast.message && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{toast.message}</p>}
      </div>
      <button onClick={() => { setVisible(false); setTimeout(() => onRemove(toast.id), 300); }} className="text-gray-400 hover:text-gray-600 text-sm leading-none">{"\u2715"}</button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const remove = useCallback((id: string) => setToasts(t => t.filter(x => x.id !== id)), []);

  const toast = useCallback(({ type, title, message }: { type: ToastType; title: string; message?: string }) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t.slice(-4), { id, type, title, message }]);
  }, []);

  const success = useCallback((title: string, message?: string) => toast({ type: "success", title, message }), [toast]);
  const error = useCallback((title: string, message?: string) => toast({ type: "error", title, message }), [toast]);
  const info = useCallback((title: string, message?: string) => toast({ type: "info", title, message }), [toast]);
  const warning = useCallback((title: string, message?: string) => toast({ type: "warning", title, message }), [toast]);

  return (
    <ToastContext.Provider value={{ toast, success, error, info, warning }}>
      {children}
      {mounted && createPortal(
        <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 items-end">
          {toasts.map(t => <ToastItem key={t.id} toast={t} onRemove={remove} />)}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
