"use client";

import { useEffect, useRef, useState } from "react";

const POLL_MS = 60_000;

// Tells every open tab when something changed server-side (right now: a
// feature flag flipped in the separate Ufirst Ops app) and it should
// refresh to pick it up. Same setInterval + fetch polling pattern as
// SupportChatWidget rather than a websocket/Realtime channel — this only
// needs to notice a change within a minute, not instantly.
// Authored by Araza.
export function UpdateAvailableBanner() {
  const [available, setAvailable] = useState(false);
  const initialVersion = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/api/platform-config", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { configVersion: number };
        if (cancelled) return;
        if (initialVersion.current === null) {
          initialVersion.current = json.configVersion;
        } else if (json.configVersion !== initialVersion.current) {
          setAvailable(true);
        }
      } catch {
        // best-effort — a failed poll just tries again next tick
      }
    };

    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!available) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-3 border-t border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800 shadow-[0_-1px_4px_rgba(0,0,0,0.05)]">
      <span>An update is available.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700"
      >
        Refresh
      </button>
      <button
        type="button"
        onClick={() => setAvailable(false)}
        className="text-blue-500 hover:text-blue-700"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
