"use client";

import { useEffect, useRef, useState } from "react";

// Searchable combobox for bill fields: type to filter, click or arrow+enter
// to pick. Submits the field's value through the hidden form like the plain
// inputs it replaces (autosave on pick or on blur when changed).
//
// Options may be:
//   - plain strings (value === label) — category, vendor, class
//   - { label, value } pairs — project (value = id, label = name), tax
//     (value = rate, label = "H (13%)")
//
// For pairs the box tracks the submitted VALUE separately from what's
// displayed: project shows the NAME but submits the id; tax shows the rate
// (showValue=true) and lists "H (13%)" in the dropdown — so typing "h"
// surfaces HST and picking stores 13, exactly like QBO/ApprovalMax.
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
function isObjOption(o: ComboboxOption): boolean {
  return typeof o !== "string";
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
  showValue = false,
  minQueryLength = 2,
}: {
  name: string;
  formId: string;
  options: ComboboxOption[];
  defaultValue: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  // Called when the value should be saved (option picked, or blur after a
  // change). Receives the final submitted value.
  onCommit: (value: string) => void;
  // Match from the start of the option (e.g. "2022-58" prefix-matches the
  // project "2022-58 (Midway Nissan)").
  matchStart?: boolean;
  // For { label, value } options: display the VALUE in the box (tax rates)
  // instead of the label (project names).
  showValue?: boolean;
  // Minimum characters before searching starts. Tax codes are single
  // letters (H, G, P), so the Tax field uses 1; big lists use 2.
  minQueryLength?: number;
}) {
  const hasPairs = options.length > 0 && isObjOption(options[0]);
  const pairForValue = (v: string) =>
    hasPairs
      ? (options.find((o) => valueOf(o) === v) as { label: string; value: string } | undefined)
      : undefined;
  const pairForLabel = (l: string) =>
    hasPairs
      ? (options.find((o) => labelOf(o).toLowerCase() === l.toLowerCase()) as
          | { label: string; value: string }
          | undefined)
      : undefined;

  // displayOf: what the box shows for a given submitted value.
  const displayOf = (v: string) => {
    if (!hasPairs) return v;
    const match = pairForValue(v);
    if (!match) return v;
    return showValue ? valueOf(match) : labelOf(match);
  };

  const [selected, setSelected] = useState(defaultValue); // submitted value
  const [query, setQuery] = useState(displayOf(defaultValue)); // shown text
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(defaultValue);

  const q = query.trim().toLowerCase();
  // Search-as-you-type: with big lists (2,045 suppliers, 454 projects) a
  // wall of options on click is useless. Only surface matches once the user
  // has typed enough (minQueryLength), then show up to 30.
  const searching = q.length >= minQueryLength;
  const filtered = searching
    ? options
        .filter((o) => {
          const label = labelOf(o).toLowerCase();
          return matchStart ? label.startsWith(q) : label.includes(q);
        })
        .slice(0, 30)
    : [];

  // Keep the hidden value input in sync with the selected value.
  useEffect(() => {
    if (hiddenRef.current) hiddenRef.current.value = selected;
  }, [selected]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        commitCurrent();
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selected]);

  function commitCurrent() {
    let value = selected;
    // For pairs: if the typed text exactly names an option, submit that
    // option's value (e.g. typed "H" → 13). Otherwise keep the picked value.
    if (hasPairs) {
      const byLabel = pairForLabel(query);
      if (byLabel) value = byLabel.value;
      else {
        const byValue = pairForValue(query);
        if (byValue) value = byValue.value;
      }
    } else {
      value = query;
    }
    if (value !== committedRef.current) {
      committedRef.current = value;
      setSelected(value);
      onCommit(value);
    }
  }

  function pick(o: ComboboxOption) {
    const v = valueOf(o);
    setSelected(v);
    setQuery(showValue && hasPairs ? v : labelOf(o));
    setOpen(false);
    if (v !== committedRef.current) {
      committedRef.current = v;
      onCommit(v);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      {hasPairs && (
        <input
          ref={hiddenRef}
          type="hidden"
          form={formId}
          name={name}
          value={selected}
        />
      )}
      <input
        form={hasPairs ? undefined : formId}
        name={hasPairs ? undefined : name}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={(e) => {
          setOpen(true);
          // Pre-filled fields (e.g. OCR'd vendor): select the existing text
          // so the first keystroke replaces it instead of appending — which
          // would make the search look for "oldname + newletters" and match
          // nothing.
          e.target.select();
        }}
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
              commitCurrent();
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
      {open && !searching && (
        <div className="absolute left-0 top-full z-30 mt-0.5 w-full min-w-[180px] rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-400 shadow-lg">
          {minQueryLength === 1
            ? "Type to search…"
            : `Type at least ${minQueryLength} characters to search…`}
        </div>
      )}
    </div>
  );
}
