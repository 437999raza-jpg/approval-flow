"use client";

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";

export interface MultiSelectOption {
  id: string;
  label: string;
}

interface MultiSelectProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

// ApprovalMax-style multi-select: a "N values" pill button that opens a
// checkbox list with a search box. Built for large option sets (e.g. 900+
// suppliers) — search, check a few, clear the search text, search again,
// check more; selections persist across searches since they live in
// `selected`, independent of whatever `query` currently filters the list.
export function MultiSelect({ label, options, selected, onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filteredOptions = options.filter((o) =>
    o.label.toLowerCase().includes(query.toLowerCase())
  );
  const allFilteredSelected =
    filteredOptions.length > 0 && filteredOptions.every((o) => selected.includes(o.id));

  // With hundreds of options, a handful of checked ones scattered
  // through one long alphabetical list were easy to lose track of —
  // there was no way to see everything currently selected without
  // scrolling to find each checkmark individually. Selected items now
  // stay pinned at the top regardless of the search query, so what's
  // picked is always visible; "All" below is just the remaining
  // (query-filtered) unselected options, so nothing appears twice.
  const selectedOptions = options.filter((o) => selected.includes(o.id));
  const filteredUnselected = filteredOptions.filter((o) => !selected.includes(o.id));

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      const filteredIds = new Set(filteredOptions.map((o) => o.id));
      onChange(selected.filter((s) => !filteredIds.has(s)));
    } else {
      onChange([...new Set([...selected, ...filteredOptions.map((o) => o.id)])]);
    }
  }

  const selectedLabel =
    selected.length > 0
      ? options
          .filter((o) => selected.includes(o.id))
          .map((o) => o.label)
          .join(", ")
      : `Select ${label.toLowerCase()}`;

  return (
    <div ref={ref} className="relative min-w-0">
      <label className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={selected.length > 0 ? selectedLabel : undefined}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-left text-sm hover:border-slate-400"
      >
        <span
          className={clsx(
            "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
            selected.length > 0 ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"
          )}
        >
          {selected.length} values
        </span>
        <span className="min-w-0 flex-1 truncate text-slate-400">{selectedLabel}</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-80 rounded-md border border-slate-200 bg-white shadow-elevation-2">
          <div className="border-b border-slate-100 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}...`}
              className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {selectedOptions.length === 0 && filteredUnselected.length === 0 ? (
              <div className="px-3 py-2 text-sm text-slate-400">No matches.</div>
            ) : (
              <>
                {selectedOptions.length > 0 && (
                  <>
                    <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Selected
                    </div>
                    {selectedOptions.map((o) => (
                      <label
                        key={o.id}
                        className="flex cursor-pointer items-center gap-2 rounded bg-blue-50/70 px-2 py-1.5 text-sm hover:bg-blue-50"
                      >
                        <input
                          type="checkbox"
                          checked
                          onChange={() => toggle(o.id)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        <span className="truncate">{o.label}</span>
                      </label>
                    ))}
                  </>
                )}
                {filteredUnselected.length > 0 && (
                  <>
                    <div className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      All{query ? ` (${filteredUnselected.length} matching)` : ""}
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleAllFiltered}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Select all{query ? " matching" : ""}
                    </label>
                    {filteredUnselected.map((o) => (
                      <label
                        key={o.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() => toggle(o.id)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        <span className="truncate">{o.label}</span>
                      </label>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
          {selected.length > 0 && (
            <div className="flex items-center justify-between border-t border-slate-100 p-2">
              <span className="text-xs text-slate-400">{selected.length} selected</span>
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-xs text-slate-500 hover:underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
