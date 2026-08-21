"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

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
  const containerRef = useRef<HTMLDivElement>(null);

  // Expanding a section that was below the fold otherwise leaves its new
  // content off-screen with no visual confirmation it opened — scroll it
  // into view once the content has actually mounted.
  useEffect(() => {
    if (open) containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);

  return (
    <div ref={containerRef} className="border-b border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer select-none items-center justify-between gap-2 bg-slate-50 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-800 hover:bg-slate-100"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {badge !== undefined && (
            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">
              {badge}
            </span>
          )}
        </span>
        <span
          className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-2 transition-colors ${
            open
              ? "border-slate-300 bg-white text-slate-700"
              : "border-slate-200 bg-white text-slate-400"
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
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
