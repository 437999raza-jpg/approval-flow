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
      className="flex items-center gap-2"
      action={async (formData) => {
        setSaving(true);
        await action(formData);
        setSavedValue(value);
        setSaving(false);
      }}
    >
      <input
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-64 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
