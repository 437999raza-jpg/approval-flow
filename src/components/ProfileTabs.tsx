"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";

// Sub-tabs within the "My profile" panel — General / Notifications /
// Security — mirroring ApprovalMax's own "Edit profile" modal rather
// than sitting as separate top-level Settings tabs. Client-side (not
// the page's :target mechanism) because :target can only track one
// active hash at a time, and "My profile" is already the outer target.
//
// /login/mfa still deep-links to /settings?mfa=reset#security after a
// recovery-code sign-in clears 2FA — read that hash once on mount so
// this still lands directly on Security instead of General.
type Tab = "general" | "notifications" | "security";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Security" },
];

export function ProfileTabs({
  general,
  notifications,
  security,
}: {
  general: React.ReactNode;
  notifications: React.ReactNode;
  security: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash === "security" || hash === "notifications") setTab(hash);
  }, []);

  const content = { general, notifications, security };

  return (
    <div>
      <div className="flex gap-5 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={clsx(
              "-mb-px border-b-2 px-1 pb-2 text-sm font-medium",
              tab === t.id
                ? "border-brand-green text-brand-ink"
                : "border-transparent text-slate-500 hover:text-slate-700"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4">{content[tab]}</div>
    </div>
  );
}
