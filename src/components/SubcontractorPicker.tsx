"use client";

import { useMemo, useState } from "react";
import { MultiSelect } from "./MultiSelect";
import { SubmitButton } from "./SubmitButton";

// Choosing which suppliers are subcontractors, from a list that is two
// thousand long on a real QuickBooks file.
//
// Built on the same MultiSelect the Dashboard and Document Search use —
// a "N values" pill that opens a searchable checkbox list — so this is
// the filter interaction already learned everywhere else in the app
// rather than a second one invented here.
//
// The job selector is the shortcut that does the real work: pick a job
// and everyone who has billed against it is ticked, because whoever
// invoiced a job IS its subcontractor list. Then uncheck the few that
// aren't — a materials supplier who happened to deliver to that site —
// which is far less work than finding fifteen names in two thousand.
//
// What submits is the complete intended set, not a diff, so filtering
// the view can never silently clear a supplier you can't currently see.
// Authored by Araza.

export interface PickerSupplier {
  id: string;
  name: string;
  isSubcontractor: boolean;
  projectIds: string[];
}

export function SubcontractorPicker({
  action,
  suppliers,
  projects,
  termNoun,
  readOnly,
}: {
  action: (formData: FormData) => void | Promise<void>;
  suppliers: PickerSupplier[];
  projects: { id: string; name: string }[];
  termNoun: string;
  readOnly: boolean;
}) {
  const initial = useMemo(
    () => suppliers.filter((s) => s.isSubcontractor).map((s) => s.id),
    [suppliers]
  );
  const [selected, setSelected] = useState<string[]>(initial);
  const [jobs, setJobs] = useState<string[]>([]);

  const byId = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);

  const dirty = useMemo(() => {
    if (selected.length !== initial.length) return true;
    const a = new Set(initial);
    return selected.some((id) => !a.has(id));
  }, [selected, initial]);

  // Picking a job adds its vendors; unpicking one leaves them, because
  // by then they've usually been curated by hand and silently dropping
  // that work would be worse than a stale extra tick.
  function onJobsChange(next: string[]) {
    const added = next.filter((id) => !jobs.includes(id));
    setJobs(next);
    if (added.length === 0 || readOnly) return;
    setSelected((prev) => {
      const merged = new Set(prev);
      for (const s of suppliers) {
        if (s.projectIds.some((p) => added.includes(p))) merged.add(s.id);
      }
      return [...merged];
    });
  }

  const supplierOptions = useMemo(
    () => suppliers.map((s) => ({ id: s.id, label: s.name })),
    [suppliers]
  );
  const projectOptions = useMemo(
    () => projects.map((p) => ({ id: p.id, label: p.name })),
    [projects]
  );

  return (
    <form action={action} className="space-y-4">
      {selected.map((id) => (
        <input key={id} type="hidden" name="supplier_ids" value={id} />
      ))}

      <div className="grid gap-3 sm:grid-cols-2">
        <MultiSelect
          label="Job — ticks everyone who billed it"
          options={projectOptions}
          selected={jobs}
          onChange={onJobsChange}
        />
        <MultiSelect
          label="Subcontractors"
          options={supplierOptions}
          selected={selected}
          onChange={readOnly ? () => {} : setSelected}
        />
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full bg-brand-mist py-0.5 pl-2.5 pr-1 text-xs text-brand-ink"
            >
              {byId.get(id)?.name ?? "Unknown"}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setSelected((p) => p.filter((s) => s !== id))}
                  aria-label={`Remove ${byId.get(id)?.name ?? "supplier"}`}
                  className="rounded-full px-1 text-brand-muted hover:bg-brand-line hover:text-brand-ink"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton
            disabled={!dirty}
            className={`rounded-lg px-3 py-1.5 text-sm font-display font-bold ${
              dirty
                ? "bg-brand-green text-white hover:bg-brand-green-dark"
                : "cursor-default bg-brand-mist text-brand-muted"
            }`}
          >
            Save {selected.length} subcontractor{selected.length === 1 ? "" : "s"}
          </SubmitButton>
          <span className="text-xs text-brand-muted">
            {termNoun} is only ever withheld from these suppliers.
          </span>
        </div>
      )}
    </form>
  );
}
