"use client";

import { useMemo, useState } from "react";
import { DirtySaveButton } from "./DirtySaveButton";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";

// The jobs side of the holdback page.
//
// A construction file has hundreds of jobs — 456 active on Fluid's — and
// rendering a card per job, each with its own date field and buttons,
// buries the two or three that actually need attention. So this shows
// what's actionable and hides the rest behind a search, the same way the
// rest of the app filters large lists.
//
// "Actionable" means holdback is outstanding on it, or someone has
// already set a performance date. A job with nothing withheld has
// nothing to do here, and there are four hundred of those.
// Authored by Araza.

export interface JobRow {
  id: string;
  name: string;
  rate: number | null;
  substantialPerformanceAt: string | null;
  releasedAt: string | null;
  outstanding: number;
  releasable: boolean;
}

export function JobRetainageList({
  jobs,
  termNoun,
  termLower,
  defaultRate,
  currency,
  isAdmin,
  saveAction,
  requestClaims,
  release,
}: {
  jobs: JobRow[];
  termNoun: string;
  termLower: string;
  defaultRate: string;
  currency: string;
  isAdmin: boolean;
  saveAction: (formData: FormData) => void | Promise<void>;
  requestClaims: (projectId: string) => Promise<void>;
  release: (projectId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const money = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency });

  const active = useMemo(
    () => jobs.filter((j) => j.outstanding > 0 || j.substantialPerformanceAt || j.releasedAt),
    [jobs]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return jobs.filter((j) => j.name.toLowerCase().includes(q)).slice(0, 50);
    return showAll ? jobs.slice(0, 50) : active;
  }, [jobs, active, query, showAll]);

  const field =
    "rounded-lg border border-brand-line bg-white px-2.5 py-1.5 text-sm text-brand-ink focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${jobs.length.toLocaleString()} jobs…`}
          className={`${field} min-w-0 flex-1 sm:max-w-xs`}
        />
        <label className="flex items-center gap-1.5 text-xs text-brand-muted">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-brand-line"
          />
          Show all jobs
        </label>
        <span className="text-xs text-brand-muted">
          {query
            ? `${visible.length} matching`
            : showAll
              ? `first 50 of ${jobs.length.toLocaleString()}`
              : `${active.length} with ${termLower} or a date set`}
        </span>
      </div>

      {visible.length === 0 && (
        <div className="rounded-xl border border-brand-line bg-white p-5 text-sm text-brand-muted shadow-elevation-1 shadow-brand-ink/5">
          {query
            ? "No jobs match that search."
            : `No job has ${termLower} outstanding yet. Search above to set a performance date on one ahead of time.`}
        </div>
      )}

      {visible.map((j) => (
        <div
          key={j.id}
          className="rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="font-display text-sm font-extrabold text-brand-ink">{j.name}</h3>
            <span className="font-display text-base font-extrabold tabular-nums text-brand-ink">
              {money(j.outstanding)}
            </span>
          </div>

          {isAdmin && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <form action={saveAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="project_id" value={j.id} />
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                    Rate %
                  </label>
                  <input
                    name="retainage_rate"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    defaultValue={j.rate ?? ""}
                    placeholder={defaultRate}
                    className={`${field} w-20`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                    Substantial performance
                  </label>
                  <input
                    name="substantial_performance_at"
                    type="date"
                    defaultValue={j.substantialPerformanceAt ?? ""}
                    className={`${field} w-40`}
                  />
                </div>
                <DirtySaveButton />
              </form>

              {j.outstanding > 0 && (
                <ConfirmSubmitButton
                  action={requestClaims.bind(null, j.id)}
                  confirmMessage={`Email every subcontractor still owed ${termLower} on ${j.name}, asking them to invoice for it?`}
                  className="rounded-lg border border-brand-line bg-white px-3 py-1.5 text-xs font-medium text-brand-ink hover:bg-brand-mist"
                >
                  Request claims
                </ConfirmSubmitButton>
              )}

              {j.outstanding > 0 && j.releasable && (
                <ConfirmSubmitButton
                  action={release.bind(null, j.id)}
                  confirmMessage={`Mark all ${termLower} on ${j.name} as released? This closes out ${money(j.outstanding)}.`}
                  className="rounded-lg bg-brand-green px-3 py-1.5 text-xs font-display font-bold text-white hover:bg-brand-green-dark"
                >
                  Release
                </ConfirmSubmitButton>
              )}
            </div>
          )}

          {j.releasedAt && (
            <p className="mt-2 text-xs text-brand-muted">
              {termNoun} released {new Date(j.releasedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
