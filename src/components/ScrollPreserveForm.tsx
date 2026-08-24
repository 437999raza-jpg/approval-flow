"use client";

import type { FormEvent, ReactNode } from "react";

// Scroll-position handoff for Settings buttons that submit a server action
// which REDIRECTS (the QBO sync buttons, Refresh data, default tax rate,
// invite). A redirect is a navigation, and Next.js scrolls navigations back
// to the top — so pressing any of those buttons would throw the user to the
// top of a long Settings page and lose their place. We save the position
// before the submit; ScrollRestorer puts it back after the new page paints.
const SCROLL_KEY = "af-settings-scroll";

export function saveScrollPosition() {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
}

export function restoreScrollPosition() {
  if (typeof window === "undefined") return;
  const y = sessionStorage.getItem(SCROLL_KEY);
  if (y == null) return;
  sessionStorage.removeItem(SCROLL_KEY);
  const target = Number(y);
  const restore = () => window.scrollTo(0, target);
  // Beat Next's own scroll-to-top: right after paint, again shortly after,
  // and once more when the page finishes loading.
  requestAnimationFrame(restore);
  window.setTimeout(restore, 100);
  window.addEventListener("load", restore);
}

export function ScrollPreserveForm({
  action,
  className,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  className?: string;
  children: ReactNode;
}) {
  const onSubmit = (_e: FormEvent<HTMLFormElement>) => {
    saveScrollPosition();
  };
  return (
    <form action={action} className={className} onSubmit={onSubmit}>
      {children}
    </form>
  );
}
