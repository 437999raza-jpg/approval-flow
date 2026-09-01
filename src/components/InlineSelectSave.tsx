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
      {/* Deliberately still a native <select>, not the custom Combobox: for
          a three-option field the native control is the better one (real
          keyboard semantics for free, and a proper native picker on mobile).
          What made it look unfinished was that it was unstyled — rendering
          with OS chrome at a different height and font size than every
          input beside it. appearance-none + our own chevron fixes the look
          without giving up the native behaviour. */}
      <select
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="cursor-pointer appearance-none rounded-md border border-slate-300 bg-[length:14px] bg-[right_0.5rem_center] bg-no-repeat py-1.5 pl-2.5 pr-7 text-xs text-brand-ink transition-colors hover:border-slate-400 focus:border-brand-green focus:outline-none focus:ring-1 focus:ring-brand-green/30"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235A6B7E' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
        }}
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
          "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
          dirty && !saving
            ? "bg-brand-green text-white hover:bg-brand-green-dark"
            : "cursor-default bg-slate-100 text-slate-400"
        )}
      >
        {saving ? "Saving…" : dirty ? "Save" : "Saved"}
      </button>
    </form>
  );
}
