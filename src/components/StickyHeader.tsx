"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Measures its own rendered height and applies it as scroll-padding-top on
// the nearest scrolling ancestor (the shared layout's .overflow-y-auto
// pane), so the browser's native "scroll this #anchor into view" — used by
// Settings' section tabs — never tucks a panel's own heading behind this
// sticky header, no matter how tall the header actually is or how it
// changes later (a longer subtitle, an extra pill, a font-size tweak).
// Replaces a hand-maintained scroll-mt-* guess repeated on every single
// panel, which drifted out of sync with the header's real height more than
// once — this measures itself instead of needing to be kept in sync by hand.
export function StickyHeader({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scrollParent = el.closest(".overflow-y-auto") as HTMLElement | null;
    if (!scrollParent) return;

    const apply = () => {
      scrollParent.style.scrollPaddingTop = `${el.getBoundingClientRect().height}px`;
    };
    apply();

    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      scrollParent.style.scrollPaddingTop = "";
    };
  }, []);

  return (
    <div ref={ref} className="sticky top-0 z-10 bg-slate-50 pb-4 pt-8">
      {children}
    </div>
  );
}
