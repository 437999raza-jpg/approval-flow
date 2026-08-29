"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState } from "react";
import type { DocumentSearchFilters } from "@/components/DocumentSearchModal";

// A handful of words that signal "this is a sentence, not a literal
// vendor/file/invoice# to substring-match" — e.g. "show me invoices from
// Sat Metal that aren't approved yet". Kept deliberately small: most
// searches (typing a vendor name) should stay instant and free, never
// touching the AI path below. Authored by Araza.
const NL_CUE_WORDS = new Set([
  "from", "not", "only", "waiting", "approved", "pending", "who", "show",
  "find", "still", "before", "after", "over", "under", "between", "is",
  "are", "that", "yet",
]);

function looksLikeNaturalLanguage(query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 4) return true;
  return words.some((w) => NL_CUE_WORDS.has(w));
}

export function SearchInput({
  defaultValue,
  placeholder = "Search vendor, file, invoice #...",
}: {
  defaultValue: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(defaultValue);
  const [pending, setPending] = useState(false);

  function plainSubmit(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("q", next);
    else params.delete("q");
    router.push(`${pathname}?${params.toString()}`);
  }

  async function aiSubmit(query: string) {
    setPending(true);
    try {
      const res = await fetch("/api/dashboard/nl-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const json = (await res.json()) as { filters: Partial<DocumentSearchFilters> | null };
      if (!json.filters) {
        plainSubmit(query);
        return;
      }
      const f = json.filters;
      const params = new URLSearchParams();
      if (f.status?.length) params.set("status", f.status.join(","));
      if (f.holder?.length) params.set("holder", f.holder.join(","));
      if (f.requester?.length) params.set("requester", f.requester.join(","));
      if (f.approvedBy?.length) params.set("approvedBy", f.approvedBy.join(","));
      if (f.supplier?.length) params.set("supplier", f.supplier.join(","));
      if (f.customer?.length) params.set("customer", f.customer.join(","));
      if (f.number) params.set("number", f.number);
      if (f.dateFrom) params.set("dateFrom", f.dateFrom);
      if (f.dateTo) params.set("dateTo", f.dateTo);
      if (f.amountFrom) params.set("amountFrom", f.amountFrom);
      if (f.amountTo) params.set("amountTo", f.amountTo);
      setValue("");
      router.push(`/dashboard${params.toString() ? `?${params.toString()}` : ""}`);
    } catch {
      // Best-effort — a failed AI call still lets the user's typed text
      // through as a plain literal search rather than dead-ending.
      plainSubmit(query);
    } finally {
      setPending(false);
    }
  }

  function submit(next: string) {
    const trimmed = next.trim();
    if (trimmed && looksLikeNaturalLanguage(trimmed)) aiSubmit(trimmed);
    else plainSubmit(next);
  }

  return (
    <div className="relative w-full">
      <input
        type="search"
        placeholder={pending ? "Reading your search…" : placeholder}
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit(value)}
        onBlur={() => !pending && submit(value)}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none disabled:bg-slate-50"
      />
      {pending && (
        <div className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      )}
    </div>
  );
}
