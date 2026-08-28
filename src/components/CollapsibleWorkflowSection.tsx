"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";

// Per-workflow collapse toggle on /workflows — separate from the generic
// CollapsibleSection (BillPanel's accordion panes: plain-string title,
// whole header is the click target, no persisted state) because a
// workflow's header needs admin controls (rename/delete forms) that stay
// visible and clickable even when collapsed, not folded into the same
// toggle button. Collapsed state is remembered per `storageKey` in
// localStorage (a per-viewer convenience, not synced anywhere) so a
// workflow you've collapsed stays collapsed after a page reload.
// Authored by Araza.
export function CollapsibleWorkflowSection({
  storageKey,
  defaultOpen = true,
  title,
  actions,
  children,
}: {
  storageKey: string;
  defaultOpen?: boolean;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Must match the server-rendered `defaultOpen` on first client render
  // (hydration) — reading localStorage in the initializer instead would
  // mismatch. useLayoutEffect instead of useEffect so a stored "closed"
  // state is applied before the browser paints, not after — otherwise a
  // collapsed workflow would visibly pop open for a frame on every
  // reload before snapping shut again.
  useLayoutEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) setOpen(stored === "1");
    } catch {
      // localStorage can throw (private mode, blocked site data) — fall
      // back to defaultOpen, already set.
    }
  }, [storageKey]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // best-effort — see comment above
      }
      return next;
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <span
            className="inline-block text-xs transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ▶
          </span>
        </button>
        {title}
        <span className="flex-1" />
        {actions}
      </div>
      <div hidden={!open}>{children}</div>
    </>
  );
}
