import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { SubmitButton } from "@/components/SubmitButton";
import { DirtySaveButton } from "@/components/DirtySaveButton";
import { SubcontractorPicker } from "@/components/SubcontractorPicker";
import { JobRetainageList } from "@/components/JobRetainageList";
import { termCopy, isReleasable, isRetainageAccountLine, type RetainageTerm } from "@/lib/retainage";
import { categoryDisplayName } from "@/lib/qbo";
import {
  saveSubcontractors,
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
    subs?: string;
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

  const [{ data: ledgerSuppliers }, { data: invoices }] = await Promise.all([
      supplierIds.length
        ? supabase.from("suppliers").select("id, name, qbo_vendor_id").in("id", supplierIds)
        : Promise.resolve({ data: [] as { id: string; name: string; qbo_vendor_id: string | null }[] }),
      invoiceIds.length
        ? supabase.from("invoices").select("id, invoice_number, currency").in("id", invoiceIds)
        : Promise.resolve({ data: [] as { id: string; invoice_number: string | null; currency: string }[] }),
  ]);

  // Which jobs each supplier has billed against. Read from BOTH the
  // invoice and its lines, because a bill can carry no project of its
  // own while its lines each point at one — Ridgeline 26-2422 is exactly
  // that shape, and taking only the invoice would have found no job at
  // all for it.
  const { data: allInvoices } = await supabase
    .from("invoices")
    .select("id, supplier_id, project_id")
    .eq("organization_id", org.id)
    .not("supplier_id", "is", null)
    .limit(5000);
  const supplierByInvoice = new Map(
    (allInvoices ?? []).map((i) => [i.id, i.supplier_id as string])
  );
  const jobsBySupplier = new Map<string, Set<string>>();
  const addJob = (supplierId: string | null, projectId: string | null) => {
    if (!supplierId || !projectId) return;
    const set = jobsBySupplier.get(supplierId) ?? new Set<string>();
    set.add(projectId);
    jobsBySupplier.set(supplierId, set);
  };
  for (const i of allInvoices ?? []) addJob(i.supplier_id, i.project_id);

  const { data: projectLines } = await supabase
    .from("invoice_line_items")
    .select("invoice_id, project_id")
    .not("project_id", "is", null)
    .limit(20000);
  for (const l of projectLines ?? []) {
    addJob(supplierByInvoice.get(l.invoice_id) ?? null, l.project_id);
  }

  // Who has ALREADY billed holdback, found by the account their
  // deduction line is coded to rather than by anything they wrote in the
  // description. This is positive evidence rather than a guess: a
  // supplier with a line posted to the holdback account is a
  // subcontractor, whatever the flag currently says — so the picker
  // pre-selects them instead of asking someone to recall who they are.
  const holdbackAccount = (accounts ?? []).find(
    (a) => a.qbo_account_id === orgRow?.retainage_account_qbo_id
  );
  const accountLabel = holdbackAccount
    ? categoryDisplayName({ acctNum: holdbackAccount.acct_num, name: holdbackAccount.name })
    : null;

  const { data: codedLines } = accountLabel
    ? await supabase
        .from("invoice_line_items")
        .select("invoice_id, category, amount, project_id")
        .not("category", "is", null)
        .limit(20000)
    : { data: [] as { invoice_id: string; category: string | null; amount: number; project_id: string | null }[] };

  const suppliersWithHoldback = new Set<string>();
  const holdbackJobsBySupplier = new Map<string, Set<string>>();
  for (const l of codedLines ?? []) {
    if (!isRetainageAccountLine(l.category, accountLabel, holdbackAccount?.acct_num)) continue;
    const supplierId = supplierByInvoice.get(l.invoice_id);
    if (!supplierId) continue;
    suppliersWithHoldback.add(supplierId);
    if (l.project_id) {
      const set = holdbackJobsBySupplier.get(supplierId) ?? new Set<string>();
      set.add(l.project_id);
      holdbackJobsBySupplier.set(supplierId, set);
    }
  }

  // The flagging list is every supplier we have actually received a bill
  // from, plus anyone already flagged — not the whole vendor list.
  //
  // Two reasons. A supplier who has never invoiced cannot have holdback,
  // so listing them is noise: on this file that is 12 names instead of
  // 2,046. And PostgREST caps a response at 1,000 rows whatever .limit()
  // says, so "select every supplier" would have silently shown the first
  // thousand alphabetically and hidden the rest — a subcontractor named
  // Senoz would simply never have appeared.
  const billedCount = new Map<string, number>();
  for (const i of allInvoices ?? []) {
    if (!i.supplier_id) continue;
    billedCount.set(i.supplier_id, (billedCount.get(i.supplier_id) ?? 0) + 1);
  }
  const { data: flaggedAlready } = await supabase
    .from("suppliers")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_subcontractor", true);
  const pickerIds = [
    ...new Set([...billedCount.keys(), ...(flaggedAlready ?? []).map((s) => s.id)]),
  ];
  const { data: pickerSuppliers } = pickerIds.length
    ? await supabase
        .from("suppliers")
        .select("id, name, is_subcontractor")
        .eq("organization_id", org.id)
        .in("id", pickerIds)
    : { data: [] as { id: string; name: string; is_subcontractor: boolean }[] };
  const rankedSuppliers = [...(pickerSuppliers ?? [])].sort(
    (a, b) =>
      (billedCount.get(b.id) ?? 0) - (billedCount.get(a.id) ?? 0) ||
      a.name.localeCompare(b.name)
  );

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
      {searchParams.subs != null && (
        <p className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          {searchParams.subs} supplier{searchParams.subs === "1" ? "" : "s"} marked as
          subcontractors. Run &ldquo;Rescan invoices&rdquo; to pick up their {term.nounLower}.
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
          Jobs with {term.nounLower} outstanding, or a date already set. Search to
          reach any of the others. Set the substantial performance date to start
          the release clock — then ask that job&apos;s subcontractors to invoice for
          what&apos;s being held, since most never do on their own, which is why it
          sits on the books for years.
        </p>
        <JobRetainageList
          jobs={(projects ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            rate: p.retainage_rate,
            substantialPerformanceAt: p.substantial_performance_at,
            releasedAt: p.retainage_released_at,
            outstanding: outstandingByProject.get(p.id) ?? 0,
            releasable: isReleasable(p),
          }))}
          termNoun={term.noun}
          termLower={term.nounLower}
          defaultRate={String(orgRow?.retainage_default_rate ?? "10")}
          currency={currency}
          isAdmin={isAdmin}
          saveAction={saveProjectRetainage}
          requestClaims={requestHoldbackClaims}
          release={releaseProjectRetainage}
        />
      </section>

      {/* Subcontractor flags */}
      <section className="mt-8 scroll-mt-6" id="subcontractors">
        <h2 className={label}>Subcontractors</h2>
        <p className="mt-1 text-sm text-brand-muted">
          {term.noun} applies to suppliers working under a contract — not to
          materials or rentals. Nothing is withheld from a supplier that
          isn&apos;t ticked here. Pick a job to tick everyone who billed against
          it, then untick the ones that were materials.
        </p>
        <div className={`mt-2 ${card}`}>
          <SubcontractorPicker
            action={saveSubcontractors}
            suppliers={rankedSuppliers.map((s) => ({
              id: s.id,
              name: s.name,
              // Already flagged, OR proven by having billed holdback.
              isSubcontractor: s.is_subcontractor || suppliersWithHoldback.has(s.id),
              hasBilledHoldback: suppliersWithHoldback.has(s.id),
              projectIds: [...(jobsBySupplier.get(s.id) ?? [])],
              // Jobs where this supplier actually billed holdback —
              // what "pick a job" should tick first.
              holdbackProjectIds: [...(holdbackJobsBySupplier.get(s.id) ?? [])],
            }))}
            projects={(projects ?? []).map((p) => ({ id: p.id, name: p.name }))}
            termNoun={term.noun}
            readOnly={!isAdmin}
          />
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
