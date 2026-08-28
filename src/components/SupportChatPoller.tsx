"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Keeps the support chat feeling live without a real websocket — while
// this page is open, just re-fetch (router.refresh() re-runs the Server
// Component) every few seconds so a reply from the other side shows up
// without the viewer having to reload. Same "poll while mounted, clean up
// on unmount" shape as ExtractionPoller, simplified: nothing to call, no
// backoff — a chat page is either open (worth polling) or not (unmounted).
export function SupportChatPoller({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, router]);

  return null;
}
