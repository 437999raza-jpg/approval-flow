"use client";

import type { FormEvent, ReactNode } from "react";

// Scroll-position + active-tab handoff for Settings buttons that submit a
// server action which REDIRECTS (the QBO sync buttons, Refresh data,
// default tax rate). A redirect is a navigation: Next.js scrolls it back to
// the top, and the redirect target usually drops whatever #section hash was
// active — so pressing any of those buttons would both throw the user to
// the top of the page AND silently flip them back to the "My profile" tab
// (sections now show one at a time via CSS :target — see settings/page.tsx).
// We save both before the submit; ScrollRestorer puts them back after the
// new page paints.
const SCROLL_KEY = "af-settings-scroll";
const HASH_KEY = "af-settings-hash";

export function saveScrollPosition() {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  if (window.location.hash) sessionStorage.setItem(HASH_KEY, window.location.hash);
}

export function restoreScrollPosition() {
  if (typeof window === "undefined") return;
  const hash = sessionStorage.getItem(HASH_KEY);
  if (hash != null) {
    sessionStorage.removeItem(HASH_KEY);
    if (!window.location.hash) window.location.hash = hash;
  }
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
