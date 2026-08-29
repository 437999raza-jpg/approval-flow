import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { sendStatementEmail, updateStatementDetails, updateStatementSupplier } from "@/lib/dashboard-actions";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";
import { StatementEmailDraft } from "@/components/StatementEmailDraft";
import { StatementDetailsForm } from "@/components/StatementDetailsForm";
import { StatementSupplierField } from "@/components/StatementSupplierField";
import { LocalTime } from "@/components/LocalTime";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";

const STATEMENT_BUCKET = "statements";

export default async function StatementDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");
  if (org.role === "user") redirect("/dashboard");

  const { data: statement } = await supabase
    .from("vendor_statements")
    .select(
      "id, supplier_name, file_path, file_name, status, error_message, statement_date, statement_balance, note, created_at"
    )
    .eq("id", params.id)
    .eq("organization_id", org.id)
    .single();
  if (!statement) notFound();

  const { data: signed } = await supabase.storage
    .from(STATEMENT_BUCKET)
    .createSignedUrl(statement.file_path, 60 * 10);
  const fileUrl = signed?.signedUrl ?? null;

  const suppliers = await fetchAllQboSuppliers(supabase, org.id);

  const { data: lines } = await supabase
    .from("vendor_statement_lines")
    .select("id, invoice_number, statement_date, amount, match_status, matched_invoice_id, created_at")
    .eq("statement_id", statement.id)
    .order("created_at", { ascending: true });

  const matchedIds = (lines ?? [])
    .map((l) => l.matched_invoice_id)
    .filter((id): id is string => id != null);
  const { data: matchedInvoices } = matchedIds.length
    ? await supabase
        .from("invoices")
        .select("id, status, qbo_sync_status, qbo_bill_id")
        .in("id", matchedIds)
    : { data: [] };
  const invoiceById = new Map((matchedInvoices ?? []).map((i) => [i.id, i]));

  // Flow's own outstanding balance for this vendor: every invoice not yet
  // marked paid — same "still owed" semantics runQboPaymentSync (src/lib/
  // qbo.ts) uses to decide which bills still need checking.
  const { data: vendorInvoices } = await supabase
    .from("invoices")
    .select("amount, qbo_payment_status")
    .eq("organization_id", org.id)
    .ilike("vendor_name", statement.supplier_name);
  // .neq() on a nullable column drops NULL rows entirely (NULL != 'paid'
  // is NULL, not true, in SQL) — filtering in JS instead so an invoice
  // that hasn't been checked against QBO yet still counts as outstanding,
  // same "still owed" semantics as runQboPaymentSync.
  const flowBalance = (vendorInvoices ?? [])
    .filter((i) => i.qbo_payment_status !== "paid")
    .reduce((sum, i) => sum + (i.amount ?? 0), 0);

  const hasBothBalances = statement.statement_balance != null;
  const balanceDiff = hasBothBalances ? statement.statement_balance! - flowBalance : null;
  const balanceMismatch = balanceDiff != null && Math.abs(balanceDiff) > 0.01;

  // Best-effort default "To" — the vendor's own email, as OCR'd off any
  // recent invoice from them (there's no dedicated per-supplier email
  // field — see the same reasoning in BillPanel.tsx). Empty if none found;
  // the admin can always type it in.
  const { data: recentInvoice } = await supabase
    .from("invoices")
    .select("extraction")
    .eq("organization_id", org.id)
    .ilike("vendor_name", statement.supplier_name)
    .not("extraction", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  const defaultTo =
    (recentInvoice ?? [])
      .map((i) => (i.extraction as Record<string, unknown> | null)?.vendor_email)
      .find((e): e is string => typeof e === "string" && e.length > 0) ?? "";

  const missingLines = (lines ?? []).filter((l) => l.match_status === "missing_in_flow");

  const money = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prettyDate = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const defaultSubject = `Missing Invoice${missingLines.length === 1 ? "" : "s"} — Statement Reconciliation (${org.name})`;
  const defaultBody = [
    `Dear ${statement.supplier_name},`,
    "",
    `We are reconciling your most recent statement against our records and were unable to locate the following invoice${missingLines.length === 1 ? "" : "s"} in our system:`,
    "",
    ...missingLines.map(
      (l) =>
        `  • Invoice #${l.invoice_number}${l.statement_date ? `, dated ${prettyDate(l.statement_date)}` : ""}${l.amount != null ? ` — $${money(l.amount)}` : ""}`
    ),
    "",
    `Could you please send us a copy of the invoice${missingLines.length === 1 ? "" : "s"} listed above so that we may complete our reconciliation and process payment accordingly?`,
    "",
    "Thank you for your assistance.",
    "",
    "Best regards,",
    `Accounts Payable`,
    org.name,
  ].join("\n");

  return (
    <div className="flex h-screen flex-col">
      <div className="flex flex-none items-center justify-between border-b border-brand-line bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/statements" className="text-sm text-brand-muted hover:text-brand-navy hover:underline">
            ← Back to statements
          </Link>
          <span className="text-sm font-medium text-brand-ink">{statement.file_name}</span>
        </div>
        {fileUrl && (
          <a href={fileUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand-navy hover:underline">
            Open in new tab ↗
          </a>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left: the statement PDF itself, via the browser's native PDF
            plugin (same <object> pattern as DetailSplit.tsx's bill
            document viewer) — the page-nav/zoom/download/print controls
            come from the browser, not custom-built. */}
        <div className="flex min-w-0 flex-[1.1] flex-col border-r border-slate-200 bg-slate-100 p-4">
          {fileUrl ? (
            <object data={fileUrl} type="application/pdf" className="h-full w-full">
              <p className="text-sm text-slate-500">
                Your browser can&apos;t display this PDF.{" "}
                <a href={fileUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                  Open it instead
                </a>
                .
              </p>
            </object>
          ) : (
            <p className="text-sm text-slate-500">File preview unavailable.</p>
          )}
        </div>

        {/* Right: statement details + reconciliation. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <p className="text-[11px] font-bold uppercase tracking-wide text-brand-green-dark">
            {statement.supplier_name}
          </p>
          <p className="mt-0.5 text-xs text-brand-muted">
            Uploaded <LocalTime iso={statement.created_at} />
          </p>

          {statement.status === "error" && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {statement.error_message ?? "Could not process this statement."}
            </div>
          )}

          {statement.status === "reconciled" && (
            <>
              {balanceMismatch ? (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-semibold">
                    The outstanding balance on the statement does not match Flow&apos;s records
                  </p>
                  <ul className="mt-1.5 list-disc pl-5">
                    <li>Outstanding balance on the statement: ${money(statement.statement_balance!)}</li>
                    <li>Outstanding balance in Flow: ${money(flowBalance)}</li>
                    <li>
                      Difference:{" "}
                      <span className="font-semibold text-amber-700">${money(Math.abs(balanceDiff!))}</span>
                    </li>
                  </ul>
                </div>
              ) : (
                <p className="mt-4 text-xs text-brand-muted">
                  Outstanding in Flow: ${money(flowBalance)}
                  {hasBothBalances && ` · on statement: $${money(statement.statement_balance!)} · matches`}
                </p>
              )}

              <section className="mt-4">
                <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
                  Supplier statement details
                </div>
                {statement.supplier_name === "Unknown vendor" && (
                  <p className="mt-2 text-xs text-amber-700">
                    Flow couldn&apos;t read a vendor name off this statement — pick the right one
                    below to reconcile it.
                  </p>
                )}
                <div className="mt-2 rounded-lg border border-brand-line bg-white p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
                        Supplier
                      </label>
                      <div className="mt-1">
                        <StatementSupplierField
                          statementId={statement.id}
                          supplierName={statement.supplier_name}
                          suppliers={suppliers}
                          action={updateStatementSupplier}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="mt-3">
                    <StatementDetailsForm
                      statementId={statement.id}
                      statementDate={statement.statement_date}
                      statementBalance={statement.statement_balance}
                      note={statement.note}
                      action={updateStatementDetails}
                    />
                  </div>
                </div>
              </section>

              <section className="mt-6">
                <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
                  Reconciliation ({(lines ?? []).length})
                </div>
                <div className="mt-2 overflow-hidden rounded-lg border border-brand-line bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-brand-line bg-brand-mist text-[11px] font-bold uppercase tracking-wide text-brand-muted">
                        <th className="px-4 py-2 text-left">Status</th>
                        <th className="px-4 py-2 text-left">Date</th>
                        <th className="px-4 py-2 text-left">Reference</th>
                        <th className="px-4 py-2 text-right">Amount</th>
                        <th className="px-4 py-2 text-right"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(lines ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-3 text-brand-muted">
                            No lines were read from this statement.
                          </td>
                        </tr>
                      ) : (
                        (lines ?? []).map((l) => {
                          const matchedInvoice = l.matched_invoice_id
                            ? invoiceById.get(l.matched_invoice_id)
                            : null;
                          return (
                            <tr key={l.id} className="border-b border-brand-line last:border-0">
                              <td className="px-4 py-2.5">
                                {l.match_status === "missing_in_flow" || !matchedInvoice ? (
                                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                                    Missing in Flow
                                  </span>
                                ) : matchedInvoice.qbo_sync_status === "synced" &&
                                  matchedInvoice.qbo_bill_id ? (
                                  <a
                                    href={`https://qbo.intuit.com/app/bill?txnId=${matchedInvoice.qbo_bill_id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    title="Open this bill in QuickBooks Online"
                                    className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 hover:bg-emerald-200"
                                  >
                                    Pushed to QBO ↗
                                  </a>
                                ) : (
                                  <InvoiceStatusBadge status={matchedInvoice.status} />
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-brand-muted">{l.statement_date ?? "—"}</td>
                              <td className="px-4 py-2.5 font-medium text-brand-ink">{l.invoice_number}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {l.amount != null ? `$${money(l.amount)}` : "—"}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {l.matched_invoice_id && (
                                  <Link
                                    href={`/dashboard/${l.matched_invoice_id}`}
                                    className="text-xs text-brand-navy hover:underline"
                                  >
                                    Open →
                                  </Link>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {missingLines.length > 0 && org.role === "admin" && (
                <section className="mt-6">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-muted">
                    Email {statement.supplier_name} about the missing invoices
                  </div>
                  <StatementEmailDraft
                    defaultTo={defaultTo}
                    defaultSubject={defaultSubject}
                    defaultBody={defaultBody}
                    action={sendStatementEmail.bind(null, statement.id)}
                  />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
