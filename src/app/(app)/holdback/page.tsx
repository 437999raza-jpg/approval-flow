import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { SubmitButton } from "@/components/SubmitButton";
import { DirtySaveButton } from "@/components/DirtySaveButton";
import { categoryDisplayName } from "@/lib/qbo";
import {
  CLAIM_PLACEHOLDERS,
  DEFAULT_CLAIM_SUBJECT,
  DEFAULT_CLAIM_BODY,
} from "@/lib/claim-template";
import { termCopy, type RetainageTerm } from "@/lib/retainage";
import { HoldbackReport } from "@/components/HoldbackReport";
import {
  saveRetainageSettings,
  rescanRetainage,
  requestHoldbackClaims,
  releaseProjectRetainage,
} from "@/lib/retainage-actions";

// Holdback / retainage.
//
// The page is deliberately one thing: filter by job, see what's being
// held and from whom. Everything else — flagging suppliers, recording
// accruals — was ceremony standing between someone and the answer, so
// the report is now read LIVE from any invoice line coded to the org's
// holdback account. Nothing has to be saved before it shows.
//
// The ledger (invoice_retainage) still exists and still matters: it's
// what remembers that a claim was emailed or a job released, and it
// preserves what was actually withheld at the time even after a bill is
// re-coded. Refresh syncs it. But reading the page never depends on it.
//
// Why this exists at all: QuickBooks holds holdback either in A/P, where
// it can't be separated from ordinary payables, or in a liability
// account (Fluid: "2-1031 HB Payable"), where it's one anonymous number.
// Neither carries the job. This does.
// Authored by Araza.

const ERRORS: Record<string, string> = {
  "not-admin": "Only an admin can change holdback settings.",
  "bad-rate": "The rate must be a percentage between 0 and 100.",
  "bad-term": "Pick one of holdback, retainage or retention.",
  "bad-project": "No project was identified.",
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

  const [{ data: orgRow }, { data: projects }, { data: accounts }, { data: ledger }] =
    await Promise.all([
      supabase
        .from("organizations")
        .select("retainage_term, retainage_default_rate, retainage_account_qbo_id, retainage_claim_subject, retainage_claim_note, retainage_claim_to_email, inbound_email_local, inbound_email_token")
        .eq("id", org.id)
        .single(),
      supabase
        .from("projects")
        .select("id, name, retainage_released_at")
        .eq("organization_id", org.id)
        .order("name"),
      supabase
        .from("qbo_categories")
        .select("qbo_account_id, acct_num, name")
        .eq("organization_id", org.id)
        .eq("active", true)
        .order("name")
        .limit(1000),
      supabase
        .from("invoice_retainage")
        .select("id, invoice_id, line_item_id, project_id, supplier_id, amount, status")
        .eq("organization_id", org.id)
        .in("status", ["accrued", "claim_requested"]),
    ]);

  const term = termCopy(orgRow?.retainage_term as RetainageTerm);
  const account = (accounts ?? []).find(
    (a) => a.qbo_account_id === orgRow?.retainage_account_qbo_id
  );
  const accountLabel = account
    ? categoryDisplayName({ acctNum: account.acct_num, name: account.name })
    : null;

  // Live detection. Read the bills, find the lines coded to the holdback
  // account, and report them — no scan to run first.
  // Only the bills the ledger actually references. This used to read
  // every invoice and every line item on the org and re-detect holdback
  // on each page load — fine at seventeen bills, a full table walk per
  // viewer at a few thousand. The ledger is kept current by
  // syncInvoiceRetainage on every path that writes line items, so the
  // page is now a read of one indexed table plus the bills it names.
  const ledgerInvoiceIds = [...new Set((ledger ?? []).map((r) => r.invoice_id))];
  const { data: invoices } = ledgerInvoiceIds.length
    ? await supabase
        .from("invoices")
        .select("id, invoice_number, vendor_name, supplier_id, project_id, currency, bill_date, due_date, qbo_payment_status")
        .in("id", ledgerInvoiceIds)
    : { data: [] as { id: string; invoice_number: string | null; vendor_name: string | null; supplier_id: string | null; project_id: string | null; currency: string; bill_date: string | null; due_date: string | null; qbo_payment_status: string | null }[] };

  // Ledger state overlays the live rows: which have been chased, which
  // released. Released ones drop out of outstanding entirely.
  const ledgerByLine = new Map(
    (ledger ?? []).map((r) => [r.line_item_id ?? "", r])
  );
  const projectName = new Map((projects ?? []).map((p) => [p.id, p.name]));

  // Vendor addresses for the claim request, from the QBO mirror. Null
  // for everyone until a supplier sync has run since migration 0097
  // added the column — the dialog says so rather than failing quietly.
  const supplierIdsOnBills = [
    ...new Set((invoices ?? []).map((i) => i.supplier_id).filter(Boolean)),
  ] as string[];
  const { data: supplierRows } = supplierIdsOnBills.length
    ? await supabase
        .from("suppliers")
        .select("id, qbo_vendor_id, email")
        .in("id", supplierIdsOnBills)
    : { data: [] as { id: string; qbo_vendor_id: string | null; email: string | null }[] };
  const vendorIds = (supplierRows ?? []).map((s) => s.qbo_vendor_id).filter(Boolean) as string[];
  const { data: qboVendors } = vendorIds.length
    ? await supabase
        .from("qbo_suppliers")
        .select("qbo_vendor_id, email")
        .eq("organization_id", org.id)
        .in("qbo_vendor_id", vendorIds)
    : { data: [] as { qbo_vendor_id: string; email: string | null }[] };
  const emailByVendorId = new Map((qboVendors ?? []).map((v) => [v.qbo_vendor_id, v.email]));

  // Payment terms, so a blank due date can be derived rather than shown
  // empty. due_date is written once at ingestion, so a bill that arrived
  // before its supplier had terms set keeps a null forever — and this
  // column is exactly what a CFO plans payment from.
  const { data: termRows } = supplierIdsOnBills.length
    ? await supabase
        .from("supplier_defaults")
        .select("supplier_id, payment_terms_days")
        .eq("organization_id", org.id)
        .in("supplier_id", supplierIdsOnBills)
    : { data: [] as { supplier_id: string | null; payment_terms_days: number | null }[] };
  const termsBySupplier = new Map(
    (termRows ?? [])
      .filter((t) => t.supplier_id && t.payment_terms_days != null)
      .map((t) => [t.supplier_id as string, t.payment_terms_days as number])
  );
  const derivedDueDate = (
    billDate: string | null,
    supplierId: string | null
  ): { date: string | null; derived: boolean } => {
    const terms = supplierId ? termsBySupplier.get(supplierId) : undefined;
    if (!billDate || terms == null) return { date: null, derived: false };
    const d = new Date(`${billDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + terms);
    return { date: d.toISOString().slice(0, 10), derived: true };
  };
  // Flow's own address wins over the QBO mirror — same precedence the
  // send action uses. Without this, an address typed into the claim
  // dialog was saved to suppliers.email and then never read back, so it
  // looked like it hadn't stuck.
  const emailBySupplierId = new Map(
    (supplierRows ?? []).map((s) => [
      s.id,
      s.email ?? (s.qbo_vendor_id ? emailByVendorId.get(s.qbo_vendor_id) ?? null : null),
    ])
  );
  const defaultRate = Number(orgRow?.retainage_default_rate) || null;

  // Straight from the ledger. Amounts are already signed there:
  // positive = withheld from the vendor, negative = they invoiced it
  // back, so a vendor nets to zero once they have claimed everything.
  const invoiceById = new Map((invoices ?? []).map((i) => [i.id, i]));
  const rows = (ledger ?? []).flatMap((r) => {
    const inv = invoiceById.get(r.invoice_id);
    if (!inv) return [];
    const projectId = r.project_id ?? inv.project_id ?? null;
    return [
      {
        id: r.id,
        supplierId: r.supplier_id ?? inv.vendor_name ?? "unknown",
        supplierName: inv.vendor_name ?? "Unknown supplier",
        projectId,
        projectName: projectId ? projectName.get(projectId) ?? null : null,
        invoiceNumber: inv.invoice_number,
        supplierEmail: inv.supplier_id ? emailBySupplierId.get(inv.supplier_id) ?? null : null,
        billDate: inv.bill_date,
        dueDate: inv.due_date ?? derivedDueDate(inv.bill_date, inv.supplier_id).date,
        dueDateDerived:
          inv.due_date == null && derivedDueDate(inv.bill_date, inv.supplier_id).derived,
        paidStatus: inv.qbo_payment_status,
        amount: Number(r.amount),
      },
    ];
  });

  const currency = invoices?.[0]?.currency ?? "CAD";

  // Where subcontractors are told to send their holdback invoice.
  // Defaults to this org's own inbound address, so the claim invoice is
  // ingested and extracted automatically instead of landing in a mailbox.
  const inboundDomain = process.env.INBOUND_EMAIL_DOMAIN;
  const inboundAddress =
    inboundDomain && (orgRow?.inbound_email_local || orgRow?.inbound_email_token)
      ? `${orgRow.inbound_email_local ?? orgRow.inbound_email_token}@${inboundDomain}`
      : null;
  const sendInvoiceTo = orgRow?.retainage_claim_to_email?.trim() || inboundAddress;
  const jobsWithHoldback = [...new Set(rows.map((r) => r.projectId).filter(Boolean))] as string[];

  const field =
    "w-full rounded-lg border border-brand-line bg-white px-2.5 py-1.5 text-sm text-brand-ink focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30";

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-green-dark">
            {org.name}
          </p>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-brand-ink">
            {term.noun}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-brand-muted">
            Every invoice line coded to{" "}
            <span className="font-medium text-brand-ink">
              {accountLabel ?? `your ${term.nounLower} account`}
            </span>
            , by job and subcontractor.
          </p>
        </div>
        {isAdmin && (
          <form action={rescanRetainage}>
            <SubmitButton className="rounded-lg border border-brand-line bg-white px-3 py-2 text-sm font-medium text-brand-ink hover:bg-brand-mist">
              Refresh
            </SubmitButton>
          </form>
        )}
      </div>

      {searchParams.error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[searchParams.error] ?? "Something went wrong."}
        </p>
      )}
      {searchParams.claims_sent != null && (
        <p className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          {searchParams.claims_sent} claim request
          {searchParams.claims_sent === "1" ? "" : "s"} sent.
          {Number(searchParams.claims_skipped ?? 0) > 0 && (
            <span className="text-amber-700">
              {" "}
              {searchParams.claims_skipped} skipped — no email address on file in
              QuickBooks for that supplier.
            </span>
          )}
        </p>
      )}
      {searchParams.released && (
        <p className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          {term.noun} released.
        </p>
      )}

      {!accountLabel ? (
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-5">
          <p className="font-display text-sm font-bold text-amber-900">
            Pick your {term.nounLower} account first
          </p>
          <p className="mt-1 text-sm text-amber-900">
            Nothing can be found until Flow knows which QuickBooks account your team
            codes {term.nounLower} to. Set it under Settings below.
          </p>
        </div>
      ) : (
        <div className="mt-6">
          <HoldbackReport
            rows={rows}
            projects={(projects ?? [])
              .filter((p) => jobsWithHoldback.includes(p.id))
              .map((p) => ({ id: p.id, name: p.name }))}
            currency={currency}
            termNoun={term.noun}
            isAdmin={isAdmin}
            organizationName={org.name}
            defaultSubject={orgRow?.retainage_claim_subject ?? ""}
            defaultBody={orgRow?.retainage_claim_note ?? ""}
            sendInvoiceTo={sendInvoiceTo}
            requestClaims={requestHoldbackClaims}
            release={releaseProjectRetainage}
          />
        </div>
      )}

      {isAdmin && (
        <details className="mt-8 rounded-xl border border-brand-line bg-white shadow-elevation-1 shadow-brand-ink/5">
          <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-brand-ink">
            Settings
            <span className="ml-2 text-xs font-normal text-brand-muted">
              account, rate and what to call it
            </span>
          </summary>
          <form action={saveRetainageSettings} className="space-y-4 border-t border-brand-line p-5">
            <div className="grid gap-4 sm:grid-cols-3">
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
              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                  Expected rate %
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
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                  Where subcontractors send their invoice
                </label>
                <input
                  name="retainage_claim_to_email"
                  type="email"
                  defaultValue={orgRow?.retainage_claim_to_email ?? ""}
                  placeholder={inboundAddress ?? "ap@yourcompany.com"}
                  className={field}
                />
                <p className="mt-1 text-[11px] text-brand-muted">
                  {inboundAddress
                    ? `Leave blank to use ${inboundAddress} — invoices sent there are picked up by Flow automatically.`
                    : "Set an address for claim invoices to be sent to."}
                </p>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                  Email subject
                </label>
                <input
                  name="retainage_claim_subject"
                  defaultValue={orgRow?.retainage_claim_subject ?? ""}
                  placeholder={DEFAULT_CLAIM_SUBJECT}
                  className={field}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] font-medium text-brand-muted">
                  Email message
                </label>
                <textarea
                  name="retainage_claim_note"
                  rows={8}
                  defaultValue={orgRow?.retainage_claim_note ?? ""}
                  placeholder={DEFAULT_CLAIM_BODY}
                  className={`${field} font-mono text-[13px] leading-relaxed`}
                />
                <p className="mt-1 text-[11px] text-brand-muted">
                  Placeholders:{" "}
                  {CLAIM_PLACEHOLDERS.map((p) => p.token).join("  ")} — leave blank to
                  use the wording shown.
                </p>
              </div>
            </div>
            <DirtySaveButton />
          </form>
        </details>
      )}
    </main>
  );
}
