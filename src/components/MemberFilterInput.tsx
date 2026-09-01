"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Name/email filter for Settings → Members.
//
// Two reasons this isn't just a <form method="get"> or the Dashboard's
// <SearchInput/>:
//   - SearchInput is invoice-specific (natural-language AI search, a voice
//     mic, filter-chip parsing) and advertised itself here as "Search
//     vendor, file, invoice #…" on a screen that only filters teammates.
//   - A plain GET form can't carry the "#members" fragment (fragments are
//     never sent to the server), so submitting would navigate to /settings
//     with no hash and silently drop the user back on the "My profile"
//     tab — the same class of bug the Settings redirects were fixed for.
//
// So: debounce, then router.replace() a URL that keeps the hash. The server
// still does the actual filtering from searchParams.q.
export function MemberFilterInput({ defaultValue }: { defaultValue: string }) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const trimmed = value.trim();
      const query = trimmed ? `?q=${encodeURIComponent(trimmed)}` : "";
      router.replace(`/settings${query}#members`, { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [value, router]);

  return (
    <div className="w-80">
      <label htmlFor="member-filter" className="sr-only">
        Filter members by name or email
      </label>
      <input
        id="member-filter"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Filter by name or email…"
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-brand-ink placeholder:text-slate-400 focus:border-brand-green focus:outline-none focus:ring-1 focus:ring-brand-green/30"
      />
    </div>
  );
}
