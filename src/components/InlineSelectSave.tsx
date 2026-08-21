"use client";

import { useState } from "react";
import { clsx } from "clsx";

interface Option {
  value: string;
  label: string;
}

// A <select> + Save button pair where the button only lights up once the
// value actually differs from what's persisted — otherwise it reads "Saved"
// and is inert, instead of always looking clickable regardless of state.
export function InlineSelectSave({
  name,
  defaultValue,
  options,
  action,
}: {
  name: string;
  defaultValue: string;
  options: Option[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [value, setValue] = useState(defaultValue);
  const [savedValue, setSavedValue] = useState(defaultValue);
  const [saving, setSaving] = useState(false);
  const dirty = value !== savedValue;

  return (
    <form
      className="flex items-center gap-1"
      action={async (formData) => {
        setSaving(true);
        await action(formData);
        setSavedValue(value);
        setSaving(false);
      }}
    >
      <select
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-md border border-slate-300 px-2 py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!dirty || saving}
        className={clsx(
          "rounded-md px-2 py-1 text-xs font-medium",
          dirty && !saving
            ? "bg-slate-800 text-white hover:bg-slate-700"
            : "cursor-default bg-slate-100 text-slate-400"
        )}
      >
        {saving ? "Saving…" : dirty ? "Save" : "Saved"}
      </button>
    </form>
  );
}
