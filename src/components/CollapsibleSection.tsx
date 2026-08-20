"use client";

import { useState, type ReactNode } from "react";

// A collapsible (vertical accordion) panel. Client component with explicit
// state so toggling is guaranteed to work (native <details> + React's `open`
// handling proved unreliable) and stays collapsed across re-renders.
// Authored by Araza.
export function CollapsibleSection({
  title,
  badge,
  children,
  defaultOpen = true,
}: {
  title: string;
  badge?: string | number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer select-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {badge !== undefined && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">
              {badge}
            </span>
          )}
        </span>
        <span
          className={`flex h-6 w-6 flex-none items-center justify-center rounded-full border transition-colors ${
            open
              ? "border-slate-300 bg-slate-100 text-slate-600"
              : "border-slate-200 bg-white text-slate-400"
          }`}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
