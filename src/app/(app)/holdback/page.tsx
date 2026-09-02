import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { SubmitButton } from "@/components/SubmitButton";
import { DirtySaveButton } from "@/components/DirtySaveButton";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { termCopy, isReleasable, type RetainageTerm } from "@/lib/retainage";
import {
  setSupplierSubcontractor,
  saveRetainageSettings,
  saveProjectRetainage,
  rescanRetainage,
  requestHoldbackClaims,
  releaseProjectRetainage,
} from "@/lib/retainage-actions";

// Holdback / retainage: the money withheld from subcontractors until a
// job closes.
//
// This page exists because QuickBooks cannot answer the question. Held
// in A/P you get the vendor but can't separate holdback from ordinary
// payables; held in a liability account (what Fluid does, "HB Payable"
// 2-1031) it's cleanly separated but is one anonymous number. Neither
// carries the job. So the ledger behind this page supplies subcontractor
// + project + release state, and nets back to that account's balance —
// a supporting schedule, never a second book of record.
// Authored by Araza.

const ERRORS: Record<string, string> = {
  "not-admin": "Only an admin can change holdback settings.",
  "bad-rate": "The rate must be a percentage between 0 and 100.",
  "bad-term": "Pick one of holdback, retainage or retention.",
  "bad-project": "No project was identified.",
  "bad-supplier": "No supplier was identified.",
  "nothing-to-claim": "Nothing is outstanding on that project.",
};

export default async function HoldbackPage({
  searchParams,
}: {
  searchParams: {
    error?: string;
    scanned?: string;
    released?: string;
    claims_sent?: string;
    claims_skipped?: string;
  };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");
  if (org.role === "user") redirect("/dashboard");
  const isAdmin = org.role === "admin";

  const [{ data: orgRow }, { data: ledger }, { data: projects }, { data: accounts }] =
    await Promise.all([
      supabase
        .from("organizations")
        .select("retainage_term, retainage_default_rate, retainage_account_qbo_id")
        .eq("id", org.id)
        .single(),
      supabase
        .from("invoice_retainage")
        .select("id, amount, status, project_id, supplier_id, invoice_id, rate, claim_requested_at")
        .eq("organization_id", org.id),
      supabase
        .from("projects")
        .select("id, name, retainage_rate, substantial_performance_at, retainage_released_at")
        .eq("organization_id", org.id)
        .eq("active", true)
        .order("name"),
      supabase
        .from("qbo_categories")
        .select("qbo_account_id, acct_num, name")
        .eq("organization_id", org.id)
        .eq("active", true)
        .order("name")
        .limit(1000),
    ]);

  const term = termCopy(orgRow?.retainage_term as RetainageTerm);

  const supplierIds = [...new Set((ledger ?? []).map((r) => r.supplier_id).filter(Boolean))] as string[];
  const invoiceIds = [...new Set((ledger ?? []).map((r) => r.invoice_id))];

  const [{ data: ledgerSuppliers }, { data: invoices }, { data: topSuppliers }] =
    await Promise.all([
      supplierIds.length
        ? supabase.from("suppliers").select("id, name, qbo_vendor_id").in("id", supplierIds)
        : Promise.resolve({ data: [] as { id: string; name: string; qbo_vendor_id: string | null }[] }),
      invoiceIds.length
        ? supabase.from("invoices").select("id, invoice_number, currency").in("id", invoiceIds)
        : Promise.resolve({ data: [] as { id: string; invoice_number: string | null; currency: string }[] }),
      // The flagging list. 2,000+ suppliers is unusable alphabetically, and
      // subcontractors are the ones being billed by — so this is ordered by
      // how many invoices they've sent, which puts the real subs at the top
      // and leaves the one-off materials purchases in the tail.
      supabase
        .from("suppliers")
        .select("id, name, is_subcontractor")
        .eq("organization_id", org.id)
        .order("is_subcontractor", { ascending: false })
        .order("name")
        .limit(400),
    ]);

  const supplierName = new Map((ledgerSuppliers ?? []).map((s) => [s.id, s.name]));
  const invoiceById = new Map((invoices ?? []).map((i) => [i.id, i]));
  const projectById = new Map((projects ?? []).map((p) => [p.id, p]));
  const currency = invoices?.[0]?.currency ?? "CAD";
  const money = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency });

  const open = (ledger ?? []).filter(
    (r) => r.status === "accrued" || r.status === "claim_requested"
  );
  const outstanding = open.reduce((s, r) => s + Number(r.amount), 0);
  const released = (ledger ?? [])
    .filter((r) => r.status === "released")
    .reduce((s, r) => s + Number(r.amount), 0);

  // Outstanding by subcontractor, then by job within each.
  const bySupplier = new Map<string, { total: number; rows: typeof open }>();
  for (const r of open) {
    const key = r.supplier_id ?? "unknown";
    const entry = bySupplier.get(key) ?? { total: 0, rows: [] as typeof open };
    entry.total += Number(r.amount);
    entry.rows.push(r);
    bySupplier.set(key, entry);
  }
  const supplierRows = [...bySupplier.entries()].sort((a, b) => b[1].total - a[1].total);

  const outstandingByProject = new Map<string, number>();
  for (const r of open) {
    const key = r.project_id ?? "unassigned";
    outstandingByProject.set(key, (outstandingByProject.get(key) ?? 0) + Number(r.amount));
  }

  const holdbackAccount = (accounts ?? []).find(
    (a) => a.qbo_account_id === orgRow?.retainage_account_qbo_id
  );

  const card = "rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5";
  const label = "text-[11px] font-semibold uppercase tracking-wide text-brand-muted";
  const field =
    "w-full rounded-lg border border-brand-line bg-white px-2.5 py-1.5 text-sm text-brand-ink focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30";

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-green-dark">
          {org.name}
        </p>
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-brand-ink">
          {term.noun}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-brand-muted">
          Money withheld from subcontractors until a job closes — by sub, by job,
          and what&apos;s due for release. QuickBooks holds the balance; this is the
          schedule that explains it.
        </p>
      </div>

      {searchParams.error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[searchParams.error] ?? "Something went wrong."}
        </p>
      )}
      {searchParams.scanned != null && (
        <p className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          Scan complete — {searchParams.scanned} {term.nounLower} line
          {searchParams.scanned === "1" ? "" : "s"} recorded.
        </p>
      )}
      {searchParams.claims_sent != null && (
        <p className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          {searchParams.claims_sent} claim request
          {searchParams.claims_sent === "1" ? "" : "s"} sent.
          {Number(searchParams.claims_skipped ?? 0) > 0 && (
            <span className="text-amber-700">
              {" "}
              {searchParams.claims_skipped} skipped — no email address on file for
              that supplier in QuickBooks.
            </span>
          )}
        </p>
      )}
      {searchParams.released && (
        <p className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          {term.noun} released.
        </p>
      )}

      {/* Position */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className={card}>
          <div className={label}>Outstanding</div>
          <div className="mt-1.5 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
            {money(outstanding)}
          </div>
          <p className="mt-1 text-xs text-brand-muted">
            {open.length} line{open.length === 1 ? "" : "s"} across{" "}
            {supplierRows.length} subcontractor{supplierRows.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className={card}>
          <div className={label}>Released to date</div>
          <div className="mt-1.5 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
            {money(released)}
          </div>
        </div>
        <div className={card}>
          <div className={label}>Reconciles to</div>
          <div className="mt-1.5 font-display text-lg font-extrabold text-brand-ink">
            {holdbackAccount
              ? `${holdbackAccount.acct_num ?? ""} ${holdbackAccount.name}`.trim()
              : "— not set —"}
          </div>
          <p className="mt-1 text-xs text-brand-muted">
            Outstanding above should equal this account&apos;s balance in
            QuickBooks, for bills that have synced.
          </p>
        </div>
      </div>

      {/* Outstanding by subcontractor */}
      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={label}>Outstanding by subcontractor</h2>
          {isAdmin && (
            <form action={rescanRetainage}>
              <SubmitButton className="rounded-lg border border-brand-line bg-white px-3 py-1.5 text-xs font-medium text-brand-ink hover:bg-brand-mist">
                Rescan invoices
              </SubmitButton>
            </form>
          )}
        </div>

        {supplierRows.length === 0 ? (
          <div className={`mt-2 ${card}`}>
            <p className="text-sm text-brand-muted">
              Nothing recorded yet. Flag your subcontractors below, then run
              &ldquo;Rescan invoices&rdquo; — {term.nounLower} is only ever taken from a
              supplier working under a contract, never from materials or rentals.
            </p>
          </div>
        ) : (
          <div className="mt-2 space-y-3">
            {supplierRows.map(([supplierId, entry]) => (
              <div key={supplierId} className={card}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="font-display text-base font-extrabold text-brand-ink">
                    {supplierName.get(supplierId) ?? "Unknown supplier"}
                  </h3>
                  <span className="font-display text-lg font-extrabold tabular-nums text-brand-ink">
                    {money(entry.total)}
                  </span>
                </div>
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="border-b border-brand-line text-left text-[11px] uppercase tracking-wide text-brand-muted">
                      <th className="py-1.5 font-medium">Bill</th>
                      <th className="py-1.5 font-medium">Job</th>
                      <th className="py-1.5 text-right font-medium">Rate</th>
                      <th className="py-1.5 text-right font-medium">{term.noun}</th>
                      <th className="py-1.5 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.rows.map((r) => (
                      <tr key={r.id} className="border-b border-brand-line/60">
                        <td className="py-1.5">
                          {invoiceById.get(r.invoice_id)?.invoice_number ?? "—"}
                        </td>
                        <td className="py-1.5 text-brand-muted">
                          {r.project_id ? (
                            projectById.get(r.project_id)?.name ?? "—"
                          ) : (
                            <span className="text-amber-700">Not assigned</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-brand-muted">
                          {r.rate != null ? `${Number(r.rate).toFixed(2)}%` : "—"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {money(Number(r.amount))}
                        </td>
                        <td className="py-1.5 text-right">
                          {r.status === "claim_requested" ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                              Claim sent
                            </span>
                          ) : (
                            <span className="text-xs text-brand-muted">Accrued</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Projects: release clock and the chase */}
      <section className="mt-8 scroll-mt-6" id="projects">
        <h2 className={label}>Jobs</h2>
        <p className="mt-1 text-sm text-brand-muted">
          Set the substantial performance date to start the release clock. When a
          job closes, ask its subcontractors to invoice for what&apos;s being held —
          most never do on their own, which is why it sits on the books.
        </p>
        <div className="mt-2 space-y-3">
          {(projects ?? []).map((p) => {
            const outstandingHere = outstandingByProject.get(p.id) ?? 0;
            const releasable = isReleasable(p);
            return (
              <div key={p.id} className={card}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="font-display text-sm font-extrabold text-brand-ink">
                    {p.name}
                  </h3>
                  <span className="font-display text-base font-extrabold tabular-nums text-brand-ink">
                    {money(outstandingHere)}
                  </span>
                </div>
                {isAdmin && (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <form
                      action={saveProjectRetainage}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <input type="hidden" name="project_id" value={p.id} />
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
                          defaultValue={p.retainage_rate ?? ""}
                          placeholder={String(orgRow?.retainage_default_rate ?? "10")}
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
                          defaultValue={p.substantial_performance_at ?? ""}
                          className={`${field} w-40`}
                        />
                      </div>
                      <DirtySaveButton />
                    </form>

                    {outstandingHere > 0 && (
                      <ConfirmSubmitButton
                        action={requestHoldbackClaims.bind(null, p.id)}
                        confirmMessage={`Email every subcontractor still owed ${term.nounLower} on ${p.name}, asking them to invoice for it?`}
                        className="rounded-lg border border-brand-line bg-white px-3 py-1.5 text-xs font-medium text-brand-ink hover:bg-brand-mist"
                      >
                        Request claims
                      </ConfirmSubmitButton>
                    )}

                    {outstandingHere > 0 && releasable && (
                      <ConfirmSubmitButton
                        action={releaseProjectRetainage.bind(null, p.id)}
                        confirmMessage={`Mark all ${term.nounLower} on ${p.name} as released? This closes out ${money(outstandingHere)}.`}
                        className="rounded-lg bg-brand-green px-3 py-1.5 text-xs font-display font-bold text-white hover:bg-brand-green-dark"
                      >
                        Release
                      </ConfirmSubmitButton>
                    )}
                  </div>
                )}
                {p.retainage_released_at && (
                  <p className="mt-2 text-xs text-brand-muted">
                    Released {new Date(p.retainage_released_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Subcontractor flags */}
      <section className="mt-8 scroll-mt-6" id="subcontractors">
        <h2 className={label}>Subcontractors</h2>
        <p className="mt-1 text-sm text-brand-muted">
          {term.noun} applies to suppliers working under a contract — not to
          materials or rentals. Nothing is withheld from a supplier that isn&apos;t
          ticked here.
        </p>
        <div className={`mt-2 ${card}`}>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {(topSuppliers ?? []).map((s) => (
              <form
                key={s.id}
                action={setSupplierSubcontractor}
                className="flex items-center justify-between gap-2 border-b border-brand-line/60 py-1.5"
              >
                <input type="hidden" name="supplier_id" value={s.id} />
                <label className="flex min-w-0 items-center gap-2 text-sm text-brand-ink">
                  <input
                    type="checkbox"
                    name="is_subcontractor"
                    defaultChecked={s.is_subcontractor}
                    disabled={!isAdmin}
                    className="h-3.5 w-3.5 flex-none rounded border-brand-line"
                  />
                  <span className="truncate">{s.name}</span>
                </label>
                {isAdmin && <DirtySaveButton />}
              </form>
            ))}
          </div>
        </div>
      </section>

      {/* Settings */}
      {isAdmin && (
        <section className="mt-8 scroll-mt-6" id="settings">
          <h2 className={label}>Settings</h2>
          <form action={saveRetainageSettings} className={`mt-2 ${card} space-y-4`}>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                  What to call it
                </label>
                <select
                  name="retainage_term"
                  defaultValue={orgRow?.retainage_term ?? "holdback"}
                  className={field}
                >
                  <option value="holdback">Holdback (Canada)</option>
                  <option value="retainage">Retainage (US)</option>
                  <option value="retention">Retention (UK / AU)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                  Default rate %
                </label>
                <input
                  name="retainage_default_rate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  defaultValue={orgRow?.retainage_default_rate ?? ""}
                  placeholder="10"
                  className={field}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                  QuickBooks account
                </label>
                <select
                  name="retainage_account_qbo_id"
                  defaultValue={orgRow?.retainage_account_qbo_id ?? ""}
                  className={field}
                >
                  <option value="">— not set —</option>
                  {(accounts ?? []).map((a) => (
                    <option key={a.qbo_account_id} value={a.qbo_account_id}>
                      {[a.acct_num, a.name].filter(Boolean).join(" ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <DirtySaveButton />
          </form>
        </section>
      )}
    </main>
  );
}
