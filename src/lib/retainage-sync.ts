import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { categoryDisplayName } from "@/lib/qbo";
import { isRetainageAccountLine } from "@/lib/retainage";

// Keep the retainage ledger in step with one invoice's lines.
//
// The holdback report used to find its rows by scanning every invoice's
// line items on every page load. Correct, and fine at seventeen bills;
// at a few thousand it is a full table walk to render a page. The ledger
// exists precisely so that work happens once, when a bill changes,
// rather than once per viewer.
//
// So this is called from every path that writes line items — ingestion,
// editing a line, deleting one, cloning one, collapsing a bill,
// re-extraction — and the page reads one indexed table.
//
// Best-effort by design: it never throws. A failure here must not roll
// back the edit the user actually asked for, and Refresh rebuilds the
// whole ledger from scratch if anything is ever missed.
// Authored by Araza.
export async function syncInvoiceRetainage(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  invoiceId: string
): Promise<void> {
  try {
    const { data: org } = await supabase
      .from("organizations")
      .select("retainage_account_qbo_id")
      .eq("id", organizationId)
      .single();
    if (!org?.retainage_account_qbo_id) return; // org doesn't track retainage

    const { data: account } = await supabase
      .from("qbo_categories")
      .select("acct_num, name")
      .eq("organization_id", organizationId)
      .eq("qbo_account_id", org.retainage_account_qbo_id)
      .maybeSingle();
    if (!account) return;
    const label = categoryDisplayName({ acctNum: account.acct_num, name: account.name });

    const [{ data: invoice }, { data: lines }] = await Promise.all([
      supabase
        .from("invoices")
        .select("supplier_id, project_id")
        .eq("id", invoiceId)
        .single(),
      supabase
        .from("invoice_line_items")
        .select("id, category, amount, project_id")
        .eq("invoice_id", invoiceId),
    ]);

    const holdbackLines = (lines ?? []).filter(
      (l) =>
        isRetainageAccountLine(l.category, label, account.acct_num) &&
        Number.isFinite(Number(l.amount)) &&
        Number(l.amount) !== 0
    );
    const keep = new Set(holdbackLines.map((l) => l.id));

    // Rows whose line is no longer coded to the account — someone
    // re-coded it, and it is no longer retainage. Lines that were
    // deleted outright are already gone via the foreign key's cascade.
    const { data: existing } = await supabase
      .from("invoice_retainage")
      .select("id, line_item_id")
      .eq("invoice_id", invoiceId);
    const stale = (existing ?? [])
      .filter((r) => r.line_item_id && !keep.has(r.line_item_id))
      .map((r) => r.id);
    if (stale.length > 0) {
      await supabase.from("invoice_retainage").delete().in("id", stale);
    }

    for (const line of holdbackLines) {
      await supabase.from("invoice_retainage").upsert(
        {
          organization_id: organizationId,
          invoice_id: invoiceId,
          line_item_id: line.id,
          // The line's own job wins — two lines on one bill can belong
          // to two different jobs, which is why accruals are per line.
          project_id: line.project_id ?? invoice?.project_id ?? null,
          supplier_id: invoice?.supplier_id ?? null,
          // Signed, and flipped: a bill's holdback line is negative
          // (it reduces the bill), which is money held FROM the vendor,
          // so it reads positive here. Their later claim invoice is
          // positive on the bill and negative here, and the two net to
          // zero once they've invoiced for everything.
          amount: -Number(line.amount),
          source: "billed",
        },
        { onConflict: "line_item_id" }
      );
    }
  } catch (err) {
    // Never break the edit that triggered this. Refresh rebuilds.
    console.error("syncInvoiceRetainage failed", { invoiceId, err });
  }
}
