"use client";

import { useSupportChat } from "./SupportChatContext";

// Replaces the old <Link href="/support"> — opens the floating widget in
// place instead of navigating away to a full page, so whatever the user
// was looking at (an invoice with an error on it, most often) stays on
// screen while they type. Same markup/classes as the other sidebar nav
// items, just a button instead of a link.
export function SupportChatNavButton() {
  const { setOpen } = useSupportChat();
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      Chat with Support
    </button>
  );
}
