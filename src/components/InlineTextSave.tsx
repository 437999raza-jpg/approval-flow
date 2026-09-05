"use client";

import { useState } from "react";
import { clsx } from "clsx";

// Same dirty-state pattern as InlineSelectSave, for a plain text field (e.g.
// the profile name on the "My profile" card).
export function InlineTextSave({
  name,
  defaultValue,
  placeholder,
  action,
}: {
  name: string;
  defaultValue: string;
  placeholder?: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [value, setValue] = useState(defaultValue);
  const [savedValue, setSavedValue] = useState(defaultValue);
  const [saving, setSaving] = useState(false);
  const dirty = value !== savedValue;

  return (
    <form
      className="flex min-w-0 items-center gap-2"
      action={async (formData) => {
        setSaving(true);
        await action(formData);
        setSavedValue(value);
        setSaving(false);
      }}
    >
      {/* min-w-0 overrides flexbox's default min-width:auto (which
          otherwise refuses to shrink below the text content's own
          width) — w-64 alone forced this input to stay 256px even in a
          much narrower container, pushing the whole "My profile" card
          into horizontal overflow at phone width. max-w-64 keeps it
          from growing unnecessarily large on a wide screen. */}
      <input
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full min-w-0 max-w-64 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled={!dirty || saving}
        className={clsx(
          "rounded-md px-3 py-2 text-xs font-medium",
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
