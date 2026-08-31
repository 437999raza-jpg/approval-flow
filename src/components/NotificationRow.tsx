import Link from "next/link";
import type { ReactNode } from "react";

// A to-do-list row: `href` already carries `?n=<notificationId>` (see
// notifications/page.tsx), which the Dashboard page reads to mark THIS
// specific notification read — not every notification on that invoice,
// so opening the invoice for an unrelated reason later doesn't silently
// dismiss it. Same param the @mention/assignment/rejection email links
// carry, so both entry points work identically. No client-side action
// needed — this can stay a plain server-rendered link. Authored by Araza.
export function NotificationRow({
  href,
  read,
  children,
}: {
  href: string;
  read: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-slate-50 ${
        !read ? "bg-blue-50/60" : "opacity-60"
      }`}
    >
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-full border-2 ${
          read ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300"
        }`}
      >
        {read && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </span>
      {children}
    </Link>
  );
}
