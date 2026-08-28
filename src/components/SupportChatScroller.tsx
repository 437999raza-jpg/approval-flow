"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Auto-scrolls to the bottom on mount and whenever new messages arrive
// (via SupportChatPoller's periodic refresh) — standard chat behavior,
// so a reply from the other side is actually visible without the viewer
// having to scroll down themselves. Keyed on messageCount rather than
// re-deriving "did anything change" from the children themselves.
export function SupportChatScroller({
  messageCount,
  children,
}: {
  messageCount: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [messageCount]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto">
      {children}
    </div>
  );
}
