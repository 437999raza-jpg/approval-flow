"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(defaultValue);

  // The dropdown is portaled to document.body and positioned against the
  // input's live screen coordinates instead of a plain `absolute` child —
  // this component sits inside the Bill panel's own independently-
  // scrolling container, which clips any in-flow absolute-positioned
  // overlay at its own edge once the panel is scrolled (an ancestor's
  // overflow-y-auto clips descendants regardless of z-index). A portal
  // escapes that entirely.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = boxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // After a save the page re-renders with the SAME key, so React reuses
  // this instance and the internal state would keep showing the OLD value
  // (e.g. a project reverting to the previous one). Sync from the prop
  // whenever it changes — but only if the user isn't mid-edit.
  const editingRef = useRef(false);
  useEffect(() => {
    if (editingRef.current) return;
    setSelected(defaultValue);
    setQuery(displayOf(defaultValue));
    committedRef.current = defaultValue;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValue]);

  const q = query.trim().toLowerCase();
  // Search-as-you-type: with big lists (2,045 suppliers, 454 projects) a
  // wall of options on click is useless. Only surface matches once the user
  // has typed enough (minQueryLength). Show ALL matches (scrollable) so the
  // user can narrow down themselves — no hidden results.
  const searching = q.length >= minQueryLength;
  const matched = searching
    ? options.filter((o) => {
        const label = labelOf(o).toLowerCase();
        return matchStart ? label.startsWith(q) : label.includes(q);
      })
    : [];
  // Rank: names that START with the query first (typing "tri" should surface
  // "Tri-An Electric" before "Aetna Electric" — where "tri" hides inside
  // "elecTRIc"). Then the rest alphabetically.
  const ranked = searching
    ? [...matched].sort((a, b) => {
        const al = labelOf(a).toLowerCase();
        const bl = labelOf(b).toLowerCase();
        const aPrefix = al.startsWith(q) ? 0 : 1;
        const bPrefix = bl.startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return al.localeCompare(bl);
      })
    : [];
  const filtered = ranked;

  // Keep the hidden value input in sync with the selected value.
  useEffect(() => {
    if (hiddenRef.current) hiddenRef.current.value = selected;
  }, [selected]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      const inBox = boxRef.current && boxRef.current.contains(target);
      // The dropdown lives in a portal (document.body), outside boxRef's
      // own DOM subtree — without this check every click on an option
      // would look like an "outside" click and close+commit before the
      // option's own onMouseDown had a chance to fire pick().
      const inDropdown = dropdownRef.current && dropdownRef.current.contains(target);
      if (!inBox && !inDropdown) {
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
      // Write the hidden input's DOM value SYNCHRONOUSLY — the form submits
      // right after this, before React re-renders, so the hidden input must
      // already hold the new value or the old one gets saved (e.g. picking
      // project GM but saving the previous Lexus).
      if (hiddenRef.current) hiddenRef.current.value = value;
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
      // Same synchronous DOM write as commitCurrent — see above.
      if (hiddenRef.current) hiddenRef.current.value = v;
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
          editingRef.current = true;
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={(e) => {
          editingRef.current = true;
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
        title={query}
        className={className}
      />
      {open &&
        rect &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: rect.top + 2,
              left: rect.left,
              width: Math.max(rect.width, 180),
            }}
            className="z-50"
          >
            {filtered.length > 0 ? (
              <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-lg">
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
            ) : (
              !searching && (
                <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-400 shadow-lg">
                  {minQueryLength === 1
                    ? "Type to search…"
                    : `Type at least ${minQueryLength} characters to search…`}
                </div>
              )
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
