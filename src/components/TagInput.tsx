"use client";

import { useState } from "react";

export interface TagOption {
  id: string;
  label: string;
}

// Chip multi-value input, submitted as one hidden <input> per chip sharing
// `name` so the enclosing <form> reads it back via formData.getAll(name).
// With `options` it's a searchable pick-list (e.g. projects for the
// Customer condition); without it, freeform text chips committed with
// Enter/comma (e.g. Class, Supplier). Authored by Araza.
export function TagInput({
  name,
  initialValues,
  placeholder,
  options,
}: {
  name: string;
  initialValues: string[];
  placeholder?: string;
  options?: TagOption[];
}) {
  const [values, setValues] = useState<string[]>(initialValues);
  const [text, setText] = useState("");

  const labelOf = (v: string) => options?.find((o) => o.id === v)?.label ?? v;

  const addValue = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || values.includes(trimmed)) {
      setText("");
      return;
    }
    setValues([...values, trimmed]);
    setText("");
  };
  const removeValue = (v: string) => setValues(values.filter((x) => x !== v));

  const filteredOptions = options
    ?.filter((o) => !values.includes(o.id))
    .filter((o) => o.label.toLowerCase().includes(text.trim().toLowerCase()))
    .slice(0, 8);

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-300 p-1">
        {values.map((v) => (
          <span
            key={v}
            className="flex items-center gap-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700"
          >
            {labelOf(v)}
            <button
              type="button"
              onClick={() => removeValue(v)}
              className="text-slate-500 hover:text-slate-800"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (!options && (e.key === "Enter" || e.key === ",")) {
              e.preventDefault();
              addValue(text);
            }
            if (e.key === "Backspace" && text === "" && values.length > 0) {
              removeValue(values[values.length - 1]);
            }
          }}
          placeholder={values.length === 0 ? placeholder : ""}
          className="min-w-20 flex-1 border-none px-1 py-0.5 text-xs outline-none"
        />
      </div>
      {options && text && filteredOptions && filteredOptions.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-elevation-2">
          {filteredOptions.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => addValue(o.id)}
              className="block w-full px-2 py-1 text-left text-xs hover:bg-slate-100"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {values.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
    </div>
  );
}
