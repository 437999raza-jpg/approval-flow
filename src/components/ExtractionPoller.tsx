"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Background-extraction pump: while a page is open, polls
// /api/ingest/process every few seconds — each call runs ONE queued ingest
// job (the 20-60s extraction + invoice creation happens here, not in the
// upload/email request path). When a job finishes it refreshes the page so
// the queue/list updates in place; it polls slower when nothing is queued.
//
// onProcessed is an escape hatch for the client-driven Dashboard: that page
// owns its own data via TanStack Query and manages selection/URL state by
// hand (window.history.replaceState, not next/navigation's router) so it
// stays put on whatever invoice is open across clicks. router.refresh()
// doesn't know about that — it re-syncs the browser URL to Next's OWN last
// navigated route, which silently yanked the open invoice back to
// whatever the list's default happened to be the instant a background
// ingest job completed, mid-review, with no click involved. Pass
// onProcessed to invalidate that page's own query cache instead; every
// other (still server-rendered) page keeps the router.refresh() default.
export function ExtractionPoller({
  intervalMs = 5000,
  onProcessed,
}: {
  intervalMs?: number;
  onProcessed?: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (!alive) return;
      try {
        const res = await fetch("/api/ingest/process", {
          cache: "no-store",
        });
        if (!alive) return;
        const body = (await res.json().catch(() => ({}))) as {
          ran?: boolean;
          pending?: number;
        };
        if (body.ran) {
          if (onProcessed) onProcessed();
          else router.refresh();
        }
        const delay =
          (body.pending ?? 0) > 0 ? intervalMs : intervalMs * 4;
        if (alive) timer = setTimeout(tick, delay);
      } catch {
        if (alive) timer = setTimeout(tick, intervalMs * 4);
      }
    };

    timer = setTimeout(tick, 500);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, router, onProcessed]);

  return null;
}
