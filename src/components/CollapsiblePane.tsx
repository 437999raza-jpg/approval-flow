"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ResizeHandle } from "./ResizeHandle";
import { useDocumentFocus } from "./DocumentFocusContext";

// A collapsible vertical pane (used for the invoice list). Collapses to a
// slim strip with a chevron + vertical label, mirroring the document pane.
// Width is drag-resizable. Authored by Araza.
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
  const [width, setWidth] = useState(320);
  const { focused: docFocused } = useDocumentFocus();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Clicking an invoice is a navigation, and Next.js scrolls navigations
  // back to the top — not just the window, this nested pane too (the
  // same fight ScrollPreserveForm already won for Settings' buttons).
  // scroll={false} on the invoice Link didn't fully stop it here, so this
  // actively re-applies the saved position instead of trusting Next not
  // to touch it. Keyed by title so a second pane using this component
  // elsewhere wouldn't collide.
  const scrollKey = `af-pane-scroll:${title}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = sessionStorage.getItem(scrollKey);
    if (saved == null) return;
    const target = Number(saved);
    const restore = () => {
      if (el.scrollTop !== target) el.scrollTop = target;
    };
    restore();
    const raf = requestAnimationFrame(restore);
    const timeout = window.setTimeout(restore, 100);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  });

  // A document open for the 50/50 split takes the whole screen — not even
  // the collapsed strip stays. open/width are untouched, so whatever state
  // this was in comes right back once the document closes.
  if (docFocused) return null;

  if (!open) {
    // Matches the Documents pane's own collapsed strip (DetailSplit.tsx)
    // exactly — same fixed width, background, bordered/shadowed button,
    // and label weight — so the two collapsed panes read as one consistent
    // pattern instead of two different-looking treatments side by side.
    return (
      <div className="flex w-10 flex-none flex-col items-center gap-3 border-r border-slate-200 bg-slate-100 py-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={`Show ${title}`}
          className="rounded-md border border-slate-300 bg-white p-2 text-slate-700 shadow-elevation-1 hover:border-blue-400 hover:text-blue-600"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="text-xs font-semibold text-slate-700 [writing-mode:vertical-rl]">
          {title}
        </span>
      </div>
    );
  }

  return (
    <>
      <div
        style={{ width }}
        className="flex flex-none flex-col border-r border-slate-200 bg-white"
      >
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
        <div
          ref={scrollRef}
          onScroll={(e) => sessionStorage.setItem(scrollKey, String(e.currentTarget.scrollTop))}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {children}
        </div>
      </div>
      <ResizeHandle
        onDrag={(dx) => setWidth((w) => Math.min(500, Math.max(200, w + dx)))}
      />
    </>
  );
}
