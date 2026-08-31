"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { saveScrollPosition } from "./ScrollPreserveForm";

// Default tax for new invoices (Settings → Data from QuickBooks). Stored as
// a specific QBO tax CODE (e.g. H 13%), because H and "M&E (ON)" are both
// 13% and the QBO sync refuses to guess between duplicate-rate codes —
// storing the code lets ingest put the exact code (H) on new line items.
//
// The Save button stays greyed until the selected code actually differs
// from what's saved. The server action redirects and this component
// receives the new saved code as a prop, which the effect below syncs back
// into the select (the controlled-input pitfall: useState only initializes
// on mount).
export function DefaultTaxRateForm({
  currentCodeId,
  currentRate,
  codes,
  action,
}: {
  currentCodeId: string | null;
  currentRate: number | null;
  codes: { id: string; name: string; rate: number | null }[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [value, setValue] = useState(currentCodeId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After a save (server action redirect → re-render with the new saved
  // code), reset the select so it always mirrors what's actually saved.
  useEffect(() => {
    setValue(currentCodeId ?? "");
  }, [currentCodeId]);

  const dirty = value !== (currentCodeId ?? "");
  const savedCode = codes.find((c) => c.id === currentCodeId);

  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={() => {
        // The server action redirects, dropping the active #integrations
        // tab — ScrollRestorer (mounted once on the page) puts it back.
        saveScrollPosition();
      }}
      action={async (formData) => {
        setSaving(true);
        setError(null);
        try {
          await action(formData);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save.");
          setSaving(false);
        }
      }}
    >
      <select
        name="default_tax_code_id"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      >
        <option value="">— none —</option>
        {codes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.rate ?? 0}%)
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!dirty || saving}
        className={clsx(
          "rounded-md px-3 py-1.5 text-xs font-medium",
          dirty && !saving
            ? "bg-slate-800 text-white hover:bg-slate-700"
            : "cursor-default bg-slate-100 text-slate-400"
        )}
      >
        {saving ? "Saving…" : dirty ? "Save" : "Saved"}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
      <span className="text-xs text-emerald-700">
        {savedCode
          ? `Current default: ${savedCode.name} (${savedCode.rate ?? 0}%) — applied when a supplier has no rule of their own.`
          : currentRate != null
            ? `Current default: ${currentRate}%`
            : "No default set — extraction or supplier rules apply."}
      </span>
    </form>
  );
}
