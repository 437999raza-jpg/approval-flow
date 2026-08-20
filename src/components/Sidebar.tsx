"use client";

import { useState, type ReactNode } from "react";

// Collapsible left sidebar. Collapses to a slim rail with a hamburger button
// so the content gets the full width. Client component; state survives
// navigation. Authored by Araza.
export function Sidebar({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="flex w-12 flex-none flex-col items-center border-r border-slate-200 bg-white pt-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Show menu"
          className="rounded-md p-2 text-slate-500 hover:bg-slate-100"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
      <div className="flex flex-none items-center justify-end border-b border-slate-200 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Collapse menu"
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>
      {children}
    </aside>
  );
}
