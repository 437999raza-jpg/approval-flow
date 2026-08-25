"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Background-extraction pump: while a page is open, polls
// /api/ingest/process every few seconds — each call runs ONE queued ingest
// job (the 20-60s extraction + invoice creation happens here, not in the
// upload/email request path). When a job finishes it refreshes the page so
// the queue/list updates in place; it polls slower when nothing is queued.
export function ExtractionPoller({
  intervalMs = 5000,
}: {
  intervalMs?: number;
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
        if (body.ran) router.refresh();
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
  }, [intervalMs, router]);

  return null;
}
