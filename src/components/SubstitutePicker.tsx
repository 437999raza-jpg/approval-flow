"use client";

import { useState } from "react";
import { clsx } from "clsx";

interface Option {
  value: string;
  label: string;
}

// Who stands in for a member while they're away (migration 0094), plus an
// optional end date so cover expires by itself.
//
// Same "only enabled once it actually differs" pattern as
// InlineSelectSave beside it, rather than a Save button that always looks
// clickable whether or not there's anything to save. The date only
// appears once someone is chosen — an end date with nobody covering is
// meaningless state that reads as a half-finished setting.
export function SubstitutePicker({
  action,
  currentSubstituteId,
  currentUntil,
  options,
}: {
  action: (formData: FormData) => Promise<void>;
  currentSubstituteId: string | null;
  currentUntil: string | null;
  options: Option[];
}) {
  const [substitute, setSubstitute] = useState(currentSubstituteId ?? "");
  const [until, setUntil] = useState(currentUntil ?? "");
  const [saving, setSaving] = useState(false);

  const dirty =
    substitute !== (currentSubstituteId ?? "") || until !== (currentUntil ?? "");

  // Cover that has already lapsed still sits in the row until someone
  // clears it; saying so is more useful than silently showing a name that
  // is no longer routing anything.
  const expired =
    !!currentSubstituteId &&
    !!currentUntil &&
    currentUntil < new Date().toISOString().slice(0, 10);

  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      action={async (formData) => {
        setSaving(true);
        try {
          await action(formData);
        } finally {
          setSaving(false);
        }
      }}
    >
      <select
        name="substitute_user_id"
        value={substitute}
        onChange={(e) => {
          const next = e.target.value;
          setSubstitute(next);
          if (!next) setUntil("");
        }}
        className="cursor-pointer appearance-none rounded-md border border-slate-300 bg-[length:14px] bg-[right_0.5rem_center] bg-no-repeat py-1.5 pl-2.5 pr-7 text-xs text-brand-ink transition-colors hover:border-slate-400 focus:border-brand-green focus:outline-none focus:ring-1 focus:ring-brand-green/30"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235A6B7E' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
        }}
      >
        <option value="">Nobody</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {substitute && (
        <input
          type="date"
          name="substitute_until"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          title="Last day of cover — leave blank to cover until cleared"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-xs text-brand-ink focus:border-brand-green focus:outline-none focus:ring-1 focus:ring-brand-green/30"
        />
      )}

      <button
        type="submit"
        disabled={!dirty || saving}
        className={clsx(
          "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
          dirty && !saving
            ? "bg-brand-green text-white hover:bg-brand-green-dark"
            : "cursor-default bg-slate-100 text-slate-400"
        )}
      >
        {saving ? "Saving…" : dirty ? "Save" : "Saved"}
      </button>

      {expired && !dirty && (
        <span className="text-[11px] font-medium text-amber-600">Cover expired</span>
      )}
    </form>
  );
}
