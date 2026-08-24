"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";

// Default tax rate for new invoices (Settings → Data from QuickBooks).
//
// The Save button stays greyed out until a DIFFERENT rate than the saved
// one is picked. Saving goes through a server action that redirects, so the
// page re-renders with the newly saved rate as a prop — the effect below
// syncs the select back to it (the controlled-input pitfall: useState only
// initializes on mount, so without this the select would keep showing the
// pre-save value forever).
export function DefaultTaxRateForm({
  currentRate,
  rates,
  action,
}: {
  currentRate: number | null;
  rates: number[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [value, setValue] = useState(currentRate?.toString() ?? "");

  // After a save (server action redirect → re-render with the new rate),
  // reset the select so it always mirrors what's actually saved.
  useEffect(() => {
    setValue(currentRate?.toString() ?? "");
  }, [currentRate]);

  const saved = currentRate?.toString() ?? "";
  const dirty = value !== saved;

  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      action={async (formData) => {
        await action(formData);
        // The server action redirects; this line only matters if it ever
        // returns without redirecting (nothing to reset here).
      }}
    >
      <select
        name="default_tax_rate"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      >
        <option value="">— none —</option>
        {rates.map((rate) => (
          <option key={rate} value={rate}>
            {rate}%
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!dirty}
        className={clsx(
          "rounded-md px-3 py-1.5 text-xs font-medium",
          dirty
            ? "bg-slate-800 text-white hover:bg-slate-700"
            : "cursor-default bg-slate-100 text-slate-400"
        )}
      >
        {dirty ? "Save" : "Saved"}
      </button>
      <span className="text-xs text-emerald-700">
        {currentRate != null
          ? `Current default: ${currentRate}% — applied when a supplier has no rule of their own.`
          : "No default set — extraction or supplier rules apply."}
      </span>
    </form>
  );
}
