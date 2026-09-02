"use client";

import { useMemo, useState } from "react";
import { MultiSelect } from "./MultiSelect";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";
import { ClaimEmailDialog } from "./ClaimEmailDialog";

// Holdback outstanding, laid out like the QBO report it replaces:
// job, then vendor, then the bills, with a subtotal at each level.
//
// The arithmetic is the whole feature. Withholding posts a credit to the
// holdback account; the subcontractor's later invoice claiming it back
// posts the matching debit. So a vendor's balance on a job nets to zero
// the moment they invoice for it — paid or not — and a NON-ZERO balance
// means they never sent that invoice.
//
// That is exactly the list to email when a job closes, and it needs no
// status tracking to produce: the account nets itself out.
// Authored by Araza.

type VendorState = "not_invoiced" | "awaiting_pay" | "paid";

const STATE_LABEL: Record<VendorState, string> = {
  not_invoiced: "Not invoiced",
  awaiting_pay: "Invoiced, unpaid",
  paid: "Paid",
};
const STATE_TONE: Record<VendorState, string> = {
  not_invoiced: "bg-amber-100 text-amber-800",
  awaiting_pay: "bg-brand-navy/10 text-brand-navy",
  paid: "bg-brand-mist text-brand-muted",
};

export interface ReportRow {
  id: string;
  supplierId: string;
  supplierName: string;
  projectId: string | null;
  projectName: string | null;
  invoiceNumber: string | null;
  // Where a claim request would go — from the QBO vendor record.
  supplierEmail: string | null;
  billDate: string | null;
  dueDate: string | null;
  paidStatus: string | null;
  // Positive = withheld from them. Negative = they invoiced it back.
  amount: number;
}

export function HoldbackReport({
  rows,
  projects,
  currency,
  termNoun,
  isAdmin,
  requestClaims,
  release,
  organizationName,
}: {
  rows: ReportRow[];
  projects: { id: string; name: string }[];
  currency: string;
  termNoun: string;
  isAdmin: boolean;
  requestClaims: (formData: FormData) => void | Promise<void>;
  release: (projectId: string) => Promise<void>;
  organizationName: string;
}) {
  const [jobs, setJobs] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [showSettled, setShowSettled] = useState(false);

  const money = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency });
  const date = (d: string | null) =>
    d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString() : "—";

  const vendorOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.supplierId, r.supplierName);
    return [...seen]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const jobOptions = useMemo(() => {
    const present = new Set(rows.map((r) => r.projectId).filter(Boolean));
    return projects.filter((p) => present.has(p.id)).map((p) => ({ id: p.id, label: p.name }));
  }, [rows, projects]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (jobs.length && !(r.projectId && jobs.includes(r.projectId))) return false;
        if (vendors.length && !vendors.includes(r.supplierId)) return false;
        return true;
      }),
    [rows, jobs, vendors]
  );

  const grouped = useMemo(() => {
    const byJob = new Map<
      string,
      {
        name: string;
        total: number;
        byVendor: Map<string, { name: string; total: number; rows: ReportRow[] }>;
      }
    >();
    for (const r of filtered) {
      const jobKey = r.projectId ?? "__none";
      const job =
        byJob.get(jobKey) ??
        { name: r.projectName ?? "No job assigned", total: 0, byVendor: new Map() };
      job.total += r.amount;
      const v =
        job.byVendor.get(r.supplierId) ??
        { name: r.supplierName, total: 0, rows: [] as ReportRow[] };
      v.total += r.amount;
      v.rows.push(r);
      job.byVendor.set(r.supplierId, v);
      byJob.set(jobKey, job);
    }
    // Three states, because they mean three different things to whoever
    // is planning cash:
    //
    //   not_invoiced  — a balance is still held and the sub has never
    //                   billed for it. A liability, but nothing to pay
    //                   until they invoice. These are the ones to chase.
    //   awaiting_pay  — they invoiced (so it nets to zero here) but that
    //                   invoice hasn't been paid. Real cash, due soon.
    //   paid          — done.
    const out = [...byJob.entries()].map(([k, job]) => {
      const vendors = [...job.byVendor.entries()]
        .map(([id, v]) => {
          const settled = Math.abs(v.total) < 0.005;
          const claims = v.rows.filter((r) => r.amount < 0);
          const unpaidClaim = claims.some(
            (r) => (r.paidStatus ?? "").toLowerCase() !== "paid"
          );
          const state: VendorState = !settled
            ? "not_invoiced"
            : unpaidClaim
              ? "awaiting_pay"
              : "paid";
          // Age of the oldest amount still held — the number that says
          // "this has been sitting for two years".
          const oldest = v.rows
            .filter((r) => r.amount > 0 && r.billDate)
            .map((r) => new Date(r.billDate as string).getTime())
            .sort((a, b) => a - b)[0];
          const ageDays = oldest ? Math.floor((Date.now() - oldest) / 86400000) : null;
          return { id, ...v, settled, state, ageDays };
        })
        .filter((v) => showSettled || v.state !== "paid")
        .sort((a, b) => b.total - a.total || (b.ageDays ?? 0) - (a.ageDays ?? 0));
      return { key: k, ...job, vendors };
    });
    return out.filter((j) => j.vendors.length > 0).sort((a, b) => b.total - a.total);
  }, [filtered, showSettled]);

  const allVendors = grouped.flatMap((j) => j.vendors);
  const stillHeld = allVendors
    .filter((v) => v.state === "not_invoiced")
    .reduce((s, v) => s + v.total, 0);
  const chaseable = allVendors.filter((v) => v.state === "not_invoiced").length;
  // What they've invoiced but we haven't paid: real cash, and it doesn't
  // show in the balance above because it has already netted out.
  const awaitingPayment = allVendors
    .filter((v) => v.state === "awaiting_pay")
    .reduce((s, v) => s + Math.abs(v.rows.filter((r) => r.amount < 0).reduce((t, r) => t + r.amount, 0)), 0);
  const oldest = allVendors
    .filter((v) => v.state === "not_invoiced" && v.ageDays != null)
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))[0];

  function exportCsv() {
    const head = ["Job", "Vendor", "Status", "Date", "Bill", "Due", "Paid", "Amount"];
    const lines = [head.join(",")];
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    for (const job of grouped) {
      for (const v of job.vendors) {
        for (const r of v.rows) {
          lines.push([
            esc(job.name), esc(v.name), esc(STATE_LABEL[v.state]),
            esc(r.billDate ?? ""), esc(r.invoiceNumber ?? ""), esc(r.dueDate ?? ""),
            esc(r.paidStatus ?? ""), r.amount.toFixed(2),
          ].join(","));
        }
        lines.push([esc(job.name), esc(v.name), esc("Total"), "", "", "", "", v.total.toFixed(2)].join(","));
      }
      lines.push([esc(job.name), esc("Total for job"), "", "", "", "", "", job.total.toFixed(2)].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${termNoun.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <MultiSelect label="Job" options={jobOptions} selected={jobs} onChange={setJobs} />
        <MultiSelect label="Vendor" options={vendorOptions} selected={vendors} onChange={setVendors} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-brand-line bg-white px-5 py-4 shadow-elevation-1 shadow-brand-ink/5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
            Held, not yet invoiced
          </div>
          <div className="mt-1 font-display text-2xl font-extrabold tabular-nums text-brand-ink">
            {money(stillHeld)}
          </div>
          <p className="mt-0.5 text-xs text-brand-muted">
            {chaseable} vendor{chaseable === 1 ? "" : "s"} to chase
          </p>
        </div>
        <div className="rounded-xl border border-brand-line bg-white px-5 py-4 shadow-elevation-1 shadow-brand-ink/5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
            Invoiced, awaiting payment
          </div>
          <div className="mt-1 font-display text-2xl font-extrabold tabular-nums text-brand-ink">
            {money(awaitingPayment)}
          </div>
          <p className="mt-0.5 text-xs text-brand-muted">Cash to plan for</p>
        </div>
        <div className="rounded-xl border border-brand-line bg-white px-5 py-4 shadow-elevation-1 shadow-brand-ink/5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
            Oldest still held
          </div>
          <div className="mt-1 font-display text-2xl font-extrabold tabular-nums text-brand-ink">
            {oldest?.ageDays != null ? `${Math.floor(oldest.ageDays / 30)} mo` : "—"}
          </div>
          <p className="mt-0.5 truncate text-xs text-brand-muted">
            {oldest ? oldest.name : "nothing outstanding"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-1.5 text-xs text-brand-muted">
          <input
            type="checkbox"
            checked={showSettled}
            onChange={(e) => setShowSettled(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-brand-line"
          />
          Show vendors who have already been paid out
        </label>
        <button
          type="button"
          onClick={exportCsv}
          className="rounded-lg border border-brand-line bg-white px-3 py-1.5 text-xs font-medium text-brand-ink hover:bg-brand-mist"
        >
          Export CSV
        </button>
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-xl border border-brand-line bg-white px-5 py-6 text-center text-sm text-brand-muted shadow-elevation-1 shadow-brand-ink/5">
          {rows.length === 0
            ? `No lines coded to your ${termNoun.toLowerCase()} account yet.`
            : `Every vendor here has invoiced for their ${termNoun.toLowerCase()}. Tick "show settled" to see them.`}
        </p>
      ) : (
        grouped.map((job) => (
          <div
            key={job.key}
            className="rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-brand-line pb-2">
              <h3 className="font-display text-base font-extrabold text-brand-ink">
                {job.key === "__none" ? (
                  <span className="text-amber-700">No job assigned</span>
                ) : (
                  job.name
                )}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {isAdmin && job.key !== "__none" && job.total > 0 && (
                  <>
                    <ClaimEmailDialog
                      action={requestClaims}
                      projectId={job.key}
                      projectName={job.name}
                      organizationName={organizationName}
                      currency={currency}
                      termNoun={termNoun}
                      recipients={job.vendors
                        .filter((v) => v.state === "not_invoiced")
                        .map((v) => ({
                          supplierName: v.name,
                          email: v.rows.find((r) => r.supplierEmail)?.supplierEmail ?? null,
                          amount: v.total,
                          bills: v.rows
                            .filter((r) => r.amount > 0)
                            .map((r) => ({
                              invoiceNumber: r.invoiceNumber,
                              date: r.billDate,
                              amount: r.amount,
                            })),
                        }))}
                    />
                    <ConfirmSubmitButton
                      action={release.bind(null, job.key)}
                      confirmMessage={`Mark ${termNoun.toLowerCase()} on ${job.name} closed? Use this only when it's settled outside the normal invoice.`}
                      className="rounded-lg border border-brand-line bg-white px-2.5 py-1 text-xs font-medium text-brand-muted hover:bg-brand-mist"
                    >
                      Close out
                    </ConfirmSubmitButton>
                  </>
                )}
                <span className="font-display text-lg font-extrabold tabular-nums text-brand-ink">
                  {money(job.total)}
                </span>
              </div>
            </div>

            {job.vendors.map((v) => (
              <div key={v.id} className="mt-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-brand-ink">
                    {v.name}
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATE_TONE[v.state]}`}
                    >
                      {STATE_LABEL[v.state]}
                    </span>
                    {v.state === "not_invoiced" && v.ageDays != null && v.ageDays > 60 && (
                      <span className="ml-2 text-[11px] font-normal text-amber-700">
                        held {Math.floor(v.ageDays / 30)} months
                      </span>
                    )}
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-brand-ink">
                    {money(v.total)}
                  </span>
                </div>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-brand-muted">
                        <th className="py-1 font-medium">Date</th>
                        <th className="py-1 font-medium">Bill</th>
                        <th className="py-1 font-medium">Due</th>
                        <th className="py-1 font-medium">Paid</th>
                        <th className="py-1 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.rows.map((r) => (
                        <tr key={r.id} className="text-brand-muted">
                          <td className="py-0.5 tabular-nums">{date(r.billDate)}</td>
                          <td className="py-0.5 text-brand-ink">{r.invoiceNumber ?? "—"}</td>
                          <td className="py-0.5 tabular-nums">{date(r.dueDate)}</td>
                          <td className="py-0.5">{r.paidStatus ?? "—"}</td>
                          <td
                            className={`py-0.5 text-right tabular-nums ${
                              r.amount < 0 ? "text-brand-green-dark" : "text-brand-ink"
                            }`}
                          >
                            {money(r.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
      <p className="text-xs text-brand-muted">
        A vendor nets to zero once they invoice for their {termNoun.toLowerCase()},
        paid or not. Anyone still showing a balance hasn&apos;t sent that invoice —
        those are the ones to chase.
      </p>
    </div>
  );
}
