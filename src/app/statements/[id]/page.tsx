import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { sendStatementEmail } from "@/lib/dashboard-actions";
import { StatementEmailDraft } from "@/components/StatementEmailDraft";
import { LocalTime } from "@/components/LocalTime";

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
    .select("id, supplier_name, file_name, status, error_message, created_at")
    .eq("id", params.id)
    .eq("organization_id", org.id)
    .single();
  if (!statement) notFound();

  const { data: lines } = await supabase
    .from("vendor_statement_lines")
    .select("id, invoice_number, statement_date, amount, match_status, matched_invoice_id")
    .eq("statement_id", statement.id)
    .order("invoice_number", { ascending: true });

  const matchedIds = (lines ?? [])
    .map((l) => l.matched_invoice_id)
    .filter((id): id is string => id != null);
  const { data: matchedInvoices } = matchedIds.length
    ? await supabase.from("invoices").select("id, status").in("id", matchedIds)
    : { data: [] };
  const invoiceStatusById = new Map((matchedInvoices ?? []).map((i) => [i.id, i.status]));

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
  const matchedLines = (lines ?? []).filter((l) => l.match_status === "matched");

  const defaultSubject = `Missing invoice${missingLines.length === 1 ? "" : "s"} — ${org.name}`;
  const defaultBody = [
    `Hi ${statement.supplier_name},`,
    "",
    `While reconciling your latest statement, we couldn't find the following invoice${missingLines.length === 1 ? "" : "s"} in our records. Could you resend ${missingLines.length === 1 ? "it" : "them"}?`,
    "",
    ...missingLines.map(
      (l) =>
        `- ${l.invoice_number}${l.statement_date ? ` (${l.statement_date})` : ""}${l.amount != null ? ` — $${l.amount.toFixed(2)}` : ""}`
    ),
    "",
    "Thanks,",
    org.name,
  ].join("\n");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/statements"
        className="text-sm text-brand-muted hover:text-brand-navy hover:underline"
      >
        ← Back to statements
      </Link>

      <div className="mt-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-brand-green-dark">
          {statement.supplier_name}
        </p>
        <h1 className="font-display text-2xl font-extrabold text-brand-ink">
          {statement.file_name}
        </h1>
        <p className="mt-1 text-xs text-brand-muted">
          Uploaded <LocalTime iso={statement.created_at} />
        </p>
      </div>

      {statement.status === "error" && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {statement.error_message ?? "Could not process this statement."}
        </div>
      )}

      {statement.status === "reconciled" && (
        <>
          <section className="mt-6">
            <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
              Matched in Flow ({matchedLines.length})
            </div>
            {matchedLines.length === 0 ? (
              <p className="mt-2 text-sm text-brand-muted">None matched.</p>
            ) : (
              <div className="mt-2 divide-y divide-brand-line rounded-lg border border-brand-line bg-white">
                {matchedLines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <div>
                      <span className="font-medium text-brand-ink">{l.invoice_number}</span>
                      {l.statement_date && (
                        <span className="ml-2 text-xs text-brand-muted">{l.statement_date}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      {l.amount != null && (
                        <span className="text-xs text-brand-muted">${l.amount.toFixed(2)}</span>
                      )}
                      <span className="rounded-full bg-brand-mist px-2.5 py-0.5 text-xs font-medium text-brand-green-dark">
                        {invoiceStatusById.get(l.matched_invoice_id!) ?? "matched"}
                      </span>
                      {l.matched_invoice_id && (
                        <Link
                          href={`/dashboard/${l.matched_invoice_id}`}
                          className="text-xs text-brand-navy hover:underline"
                        >
                          Open →
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6">
            <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700">
              On the statement, not in Flow ({missingLines.length})
            </div>
            {missingLines.length === 0 ? (
              <p className="mt-2 text-sm text-brand-muted">Nothing missing — every invoice on this statement is already in Flow.</p>
            ) : (
              <>
                <div className="mt-2 divide-y divide-brand-line rounded-lg border border-amber-200 bg-amber-50">
                  {missingLines.map((l) => (
                    <div key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <div>
                        <span className="font-medium text-brand-ink">{l.invoice_number}</span>
                        {l.statement_date && (
                          <span className="ml-2 text-xs text-brand-muted">{l.statement_date}</span>
                        )}
                      </div>
                      {l.amount != null && (
                        <span className="text-xs text-brand-muted">${l.amount.toFixed(2)}</span>
                      )}
                    </div>
                  ))}
                </div>

                {org.role === "admin" && (
                  <div className="mt-4">
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-muted">
                      Email {statement.supplier_name} about the missing invoices
                    </div>
                    <StatementEmailDraft
                      defaultTo={defaultTo}
                      defaultSubject={defaultSubject}
                      defaultBody={defaultBody}
                      action={sendStatementEmail.bind(null, statement.id)}
                    />
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
