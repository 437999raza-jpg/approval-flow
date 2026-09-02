"use client";

import { useMemo, useState } from "react";
import { MultiSelect } from "./MultiSelect";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";

// The holdback report: what is being withheld, from whom, on which job.
//
// Filtered by job, because that is the question people actually arrive
// with — "what are we holding on 2026-143?" — and because release
// happens per job. With no job selected it shows everything, since the
// total across all jobs is the other question worth asking.
//
// Grouped job first, then subcontractor within it: a sub can appear on
// several jobs, and their holdback on each is released at a different
// time, so a single per-supplier total would be a number nobody can act
// on.
// Authored by Araza.

export interface ReportRow {
  id: string;
  supplierId: string;
  supplierName: string;
  projectId: string | null;
  projectName: string | null;
  invoiceNumber: string | null;
  amount: number;
  rate: number | null;
  status: string;
}

export function HoldbackReport({
  rows,
  projects,
  currency,
  termNoun,
  isAdmin,
  requestClaims,
  release,
}: {
  rows: ReportRow[];
  projects: { id: string; name: string }[];
  currency: string;
  termNoun: string;
  isAdmin: boolean;
  requestClaims: (projectId: string) => Promise<void>;
  release: (projectId: string) => Promise<void>;
}) {
  const [jobs, setJobs] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);

  const money = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency });

  const supplierOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.supplierId, r.supplierName);
    return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  // Only jobs that actually carry holdback — filtering by a job with
  // none would just empty the screen.
  const jobOptions = useMemo(() => {
    const withHoldback = new Set(rows.map((r) => r.projectId).filter(Boolean));
    return projects.filter((p) => withHoldback.has(p.id));
  }, [rows, projects]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (jobs.length && !(r.projectId && jobs.includes(r.projectId))) return false;
        if (suppliers.length && !suppliers.includes(r.supplierId)) return false;
        return true;
      }),
    [rows, jobs, suppliers]
  );

  const total = filtered.reduce((s, r) => s + r.amount, 0);

  // job -> supplier -> rows
  const grouped = useMemo(() => {
    const byJob = new Map<string, { name: string; total: number; bySupplier: Map<string, { name: string; total: number; rows: ReportRow[] }> }>();
    for (const r of filtered) {
      const jobKey = r.projectId ?? "__none";
      const job =
        byJob.get(jobKey) ??
        { name: r.projectName ?? "No job assigned", total: 0, bySupplier: new Map() };
      job.total += r.amount;
      const sup =
        job.bySupplier.get(r.supplierId) ??
        { name: r.supplierName, total: 0, rows: [] as ReportRow[] };
      sup.total += r.amount;
      sup.rows.push(r);
      job.bySupplier.set(r.supplierId, sup);
      byJob.set(jobKey, job);
    }
    return [...byJob.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <MultiSelect label="Job" options={jobOptions.map((p) => ({ id: p.id, label: p.name }))} selected={jobs} onChange={setJobs} />
        <MultiSelect label="Subcontractor" options={supplierOptions} selected={suppliers} onChange={setSuppliers} />
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-brand-line bg-white px-5 py-4 shadow-elevation-1 shadow-brand-ink/5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
            {jobs.length || suppliers.length ? "Matching" : "Total outstanding"}
          </div>
          <p className="mt-0.5 text-xs text-brand-muted">
            {filtered.length} line{filtered.length === 1 ? "" : "s"} across{" "}
            {grouped.length} job{grouped.length === 1 ? "" : "s"}
          </p>
        </div>
        <span className="font-display text-3xl font-extrabold tabular-nums text-brand-ink">
          {money(total)}
        </span>
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-xl border border-brand-line bg-white px-5 py-6 text-center text-sm text-brand-muted shadow-elevation-1 shadow-brand-ink/5">
          Nothing matches that filter.
        </p>
      ) : (
        grouped.map(([jobKey, job]) => (
          <div
            key={jobKey}
            className="rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-brand-line pb-2">
              <h3 className="font-display text-base font-extrabold text-brand-ink">
                {job.name === "No job assigned" ? (
                  <span className="text-amber-700">{job.name}</span>
                ) : (
                  job.name
                )}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {isAdmin && jobKey !== "__none" && (
                  <>
                    <ConfirmSubmitButton
                      action={requestClaims.bind(null, jobKey)}
                      confirmMessage={`Email every subcontractor still owed ${termNoun.toLowerCase()} on ${job.name}, asking them to invoice for it?`}
                      className="rounded-lg border border-brand-line bg-white px-2.5 py-1 text-xs font-medium text-brand-ink hover:bg-brand-mist"
                    >
                      Request claims
                    </ConfirmSubmitButton>
                    <ConfirmSubmitButton
                      action={release.bind(null, jobKey)}
                      confirmMessage={`Mark all ${termNoun.toLowerCase()} on ${job.name} as released? This closes out ${money(job.total)}.`}
                      className="rounded-lg bg-brand-green px-2.5 py-1 text-xs font-display font-bold text-white hover:bg-brand-green-dark"
                    >
                      Release
                    </ConfirmSubmitButton>
                  </>
                )}
                <span className="font-display text-lg font-extrabold tabular-nums text-brand-ink">
                  {money(job.total)}
                </span>
              </div>
            </div>
            {[...job.bySupplier.entries()]
              .sort((a, b) => b[1].total - a[1].total)
              .map(([supplierId, sup]) => (
                <div key={supplierId} className="mt-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-brand-ink">{sup.name}</span>
                    <span className="text-sm font-semibold tabular-nums text-brand-ink">
                      {money(sup.total)}
                    </span>
                  </div>
                  <table className="mt-1 w-full text-sm">
                    <tbody>
                      {sup.rows.map((r) => (
                        <tr key={r.id} className="text-brand-muted">
                          <td className="py-0.5">Bill {r.invoiceNumber ?? "—"}</td>
                          <td className="py-0.5 text-right tabular-nums">
                            {r.rate != null ? `${Number(r.rate).toFixed(2)}%` : ""}
                          </td>
                          <td className="py-0.5 text-right tabular-nums text-brand-ink">
                            {money(r.amount)}
                          </td>
                          <td className="py-0.5 pl-3 text-right">
                            {r.status === "claim_requested" && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                                Claim sent
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
        ))
      )}
      <p className="text-xs text-brand-muted">
        {termNoun} shown is what has been withheld and not yet released.
      </p>
    </div>
  );
}
