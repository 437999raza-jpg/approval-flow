"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";

// Rate-per-document editor (Billing page). The Save button stays greyed
// until the typed value actually differs from what's saved; after saving it
// reads "0.15 saved" (or the amount) and stays greyed until the next change,
// with the saved-on date shown. The server action returns { ok, error } and
// revalidates — the effect below syncs the new saved rate back into the
// input (the controlled-input pitfall: useState only initializes on mount).
export function UsageRateForm({
  currentRate,
  savedAt,
  action,
}: {
  currentRate: number;
  savedAt: string | null;
  action: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [value, setValue] = useState(String(currentRate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setValue(String(currentRate));
    setError(null);
    setJustSaved(false);
  }, [currentRate]);

  const dirty = Number(value) !== currentRate;

  const savedLabel = () => {
    if (justSaved) {
      return `${currentRate.toFixed(2)} saved`;
    }
    return "Saved";
  };

  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      action={async (formData) => {
        setSaving(true);
        setError(null);
        setJustSaved(false);
        const result = await action(formData);
        setSaving(false);
        if (!result.ok) {
          setError(result.error ?? "Could not save.");
        } else {
          setJustSaved(true);
        }
      }}
    >
      <input
        name="usage_rate_usd"
        type="number"
        step="0.01"
        min="0.01"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
          setJustSaved(false);
        }}
        className="w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      <span className="text-sm text-slate-400">USD per document</span>
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
        {saving ? "Saving…" : dirty ? "Save rate" : savedLabel()}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
      {!dirty && savedAt && (
        <span className="text-xs text-slate-500">
          Saved on{" "}
          {new Date(savedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      )}
    </form>
  );
}
