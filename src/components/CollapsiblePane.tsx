"use client";

import { useState, type ReactNode } from "react";

// A collapsible vertical pane (used for the invoice list). Collapses to a
// slim strip with a chevron + vertical label, mirroring the document pane.
// Authored by Araza.
export function CollapsiblePane({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <div className="flex flex-none flex-col items-center gap-3 border-r border-slate-200 bg-white py-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={`Show ${title}`}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="text-[11px] font-medium text-slate-400 [writing-mode:vertical-rl]">
          {title}
        </span>
      </div>
    );
  }

  return (
    <div className="flex w-80 flex-none flex-col border-r border-slate-200 bg-white">
      <div className="flex flex-none items-center justify-between border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {title}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title={`Hide ${title}`}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
