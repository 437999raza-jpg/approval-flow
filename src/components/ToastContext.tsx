"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Floating confirmation toast — the invoice you just approved/rejected/
// held disappears from view the moment the workflow moves it on (out of
// "Requires my approval", off the current screen entirely), which reads
// as "did my click actually do anything?" without this. Matches Dext/
// ApprovalMax's own floating confirmation for the same reason. A simple
// pub/sub via Context rather than a global singleton so it's scoped to
// wherever ToastProvider is mounted (the dashboard), not the whole app.
interface ToastContextValue {
  showToast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

interface ToastEntry {
  id: number;
  message: string;
  leaving: boolean;
}

let nextToastId = 1;
const TOAST_MS = 3500;

function ToastItem({ message, leaving }: { message: string; leaving: boolean }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="pointer-events-auto flex items-center gap-2.5 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg transition-all duration-200 ease-out"
      style={{
        opacity: entered && !leaving ? 1 : 0,
        transform: entered && !leaving ? "translateY(0)" : "translateY(8px)",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-none text-emerald-400">
        <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {message}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const showToast = useCallback((message: string) => {
    const id = nextToastId++;
    setToasts((prev) => [...prev, { id, message, leaving: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    }, TOAST_MS);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_MS + 200);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-[100] flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} message={t.message} leaving={t.leaving} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
