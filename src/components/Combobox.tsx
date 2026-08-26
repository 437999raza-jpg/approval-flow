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
  | { label: string; value: string; secondaryValue?: string };

function labelOf(o: ComboboxOption): string {
  return typeof o === "string" ? o : o.label;
}
function valueOf(o: ComboboxOption): string {
  return typeof o === "string" ? o : o.value;
}
function secondaryValueOf(o: ComboboxOption): string {
  return typeof o === "string" ? "" : (o.secondaryValue ?? "");
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
  secondaryName,
  wrapWhenIdle = false,
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
  // instead of the label (project names). With secondaryName set, shows
  // secondaryValue instead (the rate) while `value` (the tax code id) is
  // what's actually submitted — see secondaryName below.
  showValue?: boolean;
  // Minimum characters before searching starts. Tax codes are single
  // letters (H, G, P), so the Tax field uses 1; big lists use 2.
  minQueryLength?: number;
  // Submits a SECOND hidden field alongside `value`, from the matched
  // option's `secondaryValue`. Tax needs both: the exact QBO tax code id
  // (as `value`/`name`, since two codes can share the same rate — e.g. "H"
  // and "M&E (ON)" both at 13% — so the rate alone can't identify which
  // one was picked) and the resolved rate (as `secondaryValue`, for the
  // app's own tax-total math and display).
  secondaryName?: string;
  // For fields whose values can genuinely run long (Category, Project) —
  // an <input> can never wrap, so truncating with "…" was the only way to
  // avoid it overflowing, which silently hid part of the value. When not
  // being actively edited, show the picked value as wrapped, auto-height
  // text instead (click it to search/edit again, same as always). Off by
  // default — every other Combobox in the app (Class, Tax, Supplier,
  // workflow rules, …) keeps today's plain single-line input untouched.
  wrapWhenIdle?: boolean;
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
    if (!showValue) return labelOf(match);
    return secondaryName ? secondaryValueOf(match) || valueOf(match) : valueOf(match);
  };

  const [selected, setSelected] = useState(defaultValue); // submitted value
  const [query, setQuery] = useState(displayOf(defaultValue)); // shown text
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // wrapWhenIdle only: whether the box is being actively edited (plain
  // single-line input, dropdown available) vs. idle (wrapped, auto-height
  // display of the current value — see the render below).
  const [isFocused, setIsFocused] = useState(false);
  type DropRect = {
    left: number;
    width: number;
    maxHeight: number;
  } & ({ top: number; bottom?: undefined } | { bottom: number; top?: undefined });
  const [rect, setRect] = useState<DropRect | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const secondaryHiddenRef = useRef<HTMLInputElement>(null);
  // For plain-string options (no pairs — category, class, supplier, etc.)
  // the VISIBLE input is the field that actually submits (there's no
  // separate hidden input to write to), so it needs the exact same
  // synchronous-DOM-write treatment as hiddenRef below.
  const queryInputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(defaultValue);
  // Set right after a pick, so the effect below (which fires once the
  // autosave round-trip lands and defaultValue catches up to what we just
  // picked) knows to restore focus to this field if it got knocked away —
  // e.g. by the page-wide revalidation that autosave triggers. Without
  // this, a Tab pressed right after clicking an option can land wherever
  // focus ended up after that re-render instead of on the next field.
  const justPickedRef = useRef(false);

  // The dropdown is portaled to document.body and positioned against the
  // input's live screen coordinates instead of a plain `absolute` child —
  // this component sits inside the Bill panel's own independently-
  // scrolling container, which clips any in-flow absolute-positioned
  // overlay at its own edge once the panel is scrolled (an ancestor's
  // overflow-y-auto clips descendants regardless of z-index). A portal
  // escapes that entirely — but `position: fixed` only escapes ancestor
  // clipping, not the actual browser viewport: a full-height (288px)
  // dropdown opened near the bottom of the window still runs off-screen,
  // and since this app has no page-level scroll (fixed-height panes
  // throughout), that overflow is simply unreachable. So: flip the
  // dropdown above the field when there's more room up there than down,
  // and always cap its height to whatever space is actually available
  // in the chosen direction (it already scrolls internally past that).
  const MAX_DROPDOWN = 288; // matches the old max-h-72
  const EDGE_MARGIN = 8;
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = boxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - EDGE_MARGIN;
      const spaceAbove = r.top - EDGE_MARGIN;
      const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(80, Math.min(MAX_DROPDOWN, openUp ? spaceAbove : spaceBelow));
      setRect(
        openUp
          ? { bottom: window.innerHeight - r.top + 2, left: r.left, width: r.width, maxHeight }
          : { top: r.bottom + 2, left: r.left, width: r.width, maxHeight }
      );
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

  // Runs whenever the server-confirmed value (defaultValue) changes — which
  // includes right after this field's own pick round-trips back through a
  // save + revalidation. Only restores focus when justPickedRef marks that
  // this specific change is our own, so it never steals focus for an
  // unrelated field re-rendering elsewhere on the page.
  useEffect(() => {
    if (justPickedRef.current) {
      justPickedRef.current = false;
      queryInputRef.current?.focus();
    }
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

  // Keep the hidden value input(s) in sync with the selected value.
  useEffect(() => {
    if (hiddenRef.current) hiddenRef.current.value = selected;
    if (secondaryHiddenRef.current) {
      const match = pairForValue(selected);
      secondaryHiddenRef.current.value = match ? secondaryValueOf(match) : "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setIsFocused(false);
        commitCurrent();
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selected]);

  // wrapWhenIdle: clicking the idle (wrapped-display) view switches to the
  // real input, which needs an explicit focus() once it actually mounts —
  // a plain onClick on the div that used to be there doesn't reach it.
  useEffect(() => {
    if (isFocused) queryInputRef.current?.focus();
  }, [isFocused]);

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
      // Write the submitted field's DOM value SYNCHRONOUSLY — the form
      // submits right after this (onCommit below calls requestSubmit()),
      // before React has re-rendered, so whichever element actually
      // carries the form value must already hold the new one or the old
      // one gets saved (e.g. picking project GM but saving the previous
      // Lexus — or, for plain-string options like category, saving
      // whatever partial text was last typed instead of the full picked
      // value, since the visible input IS the submitted field there).
      if (hiddenRef.current) hiddenRef.current.value = value;
      else if (queryInputRef.current) queryInputRef.current.value = value;
      if (secondaryHiddenRef.current) {
        const match = pairForValue(value);
        secondaryHiddenRef.current.value = match ? secondaryValueOf(match) : "";
      }
      onCommit(value);
    }
  }

  function pick(o: ComboboxOption) {
    const v = valueOf(o);
    const displayText = showValue && hasPairs ? (secondaryName ? secondaryValueOf(o) || v : v) : labelOf(o);
    setSelected(v);
    setQuery(displayText);
    setOpen(false);
    if (v !== committedRef.current) {
      committedRef.current = v;
      justPickedRef.current = true;
      // Same synchronous DOM write as commitCurrent — see above.
      if (hiddenRef.current) hiddenRef.current.value = v;
      else if (queryInputRef.current) queryInputRef.current.value = displayText;
      if (secondaryHiddenRef.current) secondaryHiddenRef.current.value = secondaryValueOf(o);
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
      {hasPairs && secondaryName && (
        <input
          ref={secondaryHiddenRef}
          type="hidden"
          form={formId}
          name={secondaryName}
          defaultValue={(() => {
            const match = pairForValue(defaultValue);
            return match ? secondaryValueOf(match) : "";
          })()}
        />
      )}
      {wrapWhenIdle && (disabled || !isFocused) ? (
        <div
          tabIndex={disabled ? undefined : 0}
          onClick={() => !disabled && setIsFocused(true)}
          onFocus={() => !disabled && setIsFocused(true)}
          title={query}
          className={`${(className ?? "").replace(/\btruncate\b/g, "").trim()} ${
            disabled ? "" : "cursor-text"
          } whitespace-pre-wrap break-words`}
        >
          {query || <span className="text-slate-400">{placeholder}</span>}
        </div>
      ) : (
        <input
          ref={queryInputRef}
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
            setIsFocused(true);
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
      )}
      {wrapWhenIdle && (disabled || !isFocused) && !hasPairs && (
        // The div above replaces the input while idle, so the form needs
        // a stand-in to keep submitting `name`'s current value — the
        // plain input normally does this itself via its own name/value,
        // but it isn't mounted right now. Only ever one or the other is
        // in the DOM at a time (same condition as the div), never both.
        <input type="hidden" form={formId} name={name} value={query} readOnly />
      )}
      {open &&
        rect &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              ...(rect.top !== undefined ? { top: rect.top } : { bottom: rect.bottom }),
              left: rect.left,
              width: Math.max(rect.width, 180),
            }}
            className="z-50"
          >
            {filtered.length > 0 ? (
              <div
                style={{ maxHeight: rect.maxHeight }}
                className="overflow-y-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-lg"
              >
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
