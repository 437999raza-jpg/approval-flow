"use client";

import { useEffect, useRef, useState } from "react";

// Searchable combobox for bill fields: type to filter, click or arrow+enter
// to pick. Submits the field's value through the hidden form like the plain
// inputs it replaces (autosave on pick or on blur when changed).
//
// Options may be plain strings (value === label) or { label, value } pairs
// (e.g. project: value is the id, label is the display name).
// Authored by Araza.

export type ComboboxOption =
  | string
  | { label: string; value: string };

function labelOf(o: ComboboxOption): string {
  return typeof o === "string" ? o : o.label;
}
function valueOf(o: ComboboxOption): string {
  return typeof o === "string" ? o : o.value;
}

export function Combobox({
  name,
  formId,
  options,
  defaultValue,
  className,
  placeholder,
  disabled,
  onCommit,
  matchStart = false,
}: {
  name: string;
  formId: string;
  options: ComboboxOption[];
  defaultValue: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  // Called when the value should be saved (option picked, or blur after a
  // change). Receives the final value.
  onCommit: (value: string) => void;
  // Match from the start of the option ("hvac" → "5-15450 - HVAC" still
  // matches via substring; set true to require prefix match like "2022-58").
  matchStart?: boolean;
}) {
  const [query, setQuery] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef(defaultValue);

  const q = query.trim().toLowerCase();
  const filtered = options
    .filter((o) => {
      const label = labelOf(o).toLowerCase();
      if (!q) return true;
      return matchStart ? label.startsWith(q) : label.includes(q);
    })
    .slice(0, 20);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        commit(query);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function commit(value: string) {
    if (value !== committedRef.current) {
      committedRef.current = value;
      onCommit(value);
    }
  }

  function pick(o: ComboboxOption) {
    const v = valueOf(o);
    setQuery(v);
    setOpen(false);
    commit(v);
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        form={formId}
        name={name}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            if (open && active >= 0 && filtered[active]) {
              e.preventDefault();
              pick(filtered[active]);
            } else {
              setOpen(false);
              commit(query);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className={className}
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-0.5 max-h-52 w-full min-w-[180px] overflow-y-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-lg">
          {filtered.map((o, i) => (
            <button
              key={valueOf(o)}
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={`block w-full truncate px-2 py-1 text-left text-xs ${
                i === active ? "bg-blue-50 text-blue-700" : "text-slate-700"
              }`}
            >
              {labelOf(o)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
