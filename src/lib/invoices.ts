import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, InvoiceSource } from "@/lib/supabase/types";
import { extractInvoiceFields } from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";
import { normalizeForMatching, matchProjectFromPoNumber } from "@/lib/matching";
import { matchSupplier } from "@/lib/qbo";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";
import { computeLineItemTotals } from "@/lib/invoice-totals";

const INVOICE_BUCKET = "invoices";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export class InvoiceIngestError extends Error {}

interface SupplierDefaults {
  category: string | null;
  class: string | null;
  project_id: string | null;
  tax_rate: number | null;
  payment_terms_days: number | null;
  currency: string | null;
}

// Dext/ApprovalMax-style supplier rules, matched by normalized (trim+lower)
// vendor name — there's no first-class Supplier entity yet, so this is a
// pragmatic v1. Configured via the "Supplier rules" modal on the Bill panel.
async function getSupplierDefaults(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  vendorName: string | null
): Promise<SupplierDefaults | null> {
  if (!vendorName?.trim()) return null;
  const { data } = await supabase
    .from("supplier_defaults")
    .select("category, class, project_id, tax_rate, payment_terms_days, currency")
    .eq("organization_id", organizationId)
    .eq("vendor_name_normalized", normalizeForMatching(vendorName))
    .maybeSingle();
  return data ?? null;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Business rule: when a line item's description mentions a holdback (HB)
// and the amount is negative, the category is almost always HB Payable
// (2-1031 in QBO). Returns the display name, or null when the rule doesn't
// apply so the normal category chain (supplier rule → extraction) is used.
function hbPayableCategoryFor(li: {
  description: string | null;
  amount: number | null;
}): string | null {
  const desc = (li.description ?? "").toLowerCase();
  const amount = li.amount ?? 0;
  const mentionsHb =
    /\bhb\b|holdback|hold back|less\s*10\s*%/.test(desc);
  if (mentionsHb && amount < 0) return "2-1031 - HB Payable";
  return null;
}

interface CreateInvoiceArgs {
  supabase: SupabaseClient<Database>;
  organizationId: string;
  file: File;
  source: InvoiceSource;
  submittedBy?: string; // profile id, for manual uploads
  sourceEmail?: string; // sender address, for email uploads
}

// Single entry point for turning a file into an invoice record, regardless
// of whether it arrived via the "Add invoice" button or the inbound-email
// webhook. Uploads the file to Storage, inserts the invoice row against the
// org's default approval workflow, and writes an audit log entry.
export async function createInvoiceFromFile({
  supabase,
  organizationId,
  file,
  source,
  submittedBy,
  sourceEmail,
}: CreateInvoiceArgs) {
  if (file.size === 0) {
    throw new InvoiceIngestError("File is empty");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new InvoiceIngestError(`File exceeds ${MAX_FILE_BYTES / 1024 / 1024}MB limit`);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new InvoiceIngestError(`Unsupported file type: ${file.type || "unknown"}`);
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const filePath = `${organizationId}/${crypto.randomUUID()}-${safeName}`;

  const [{ error: uploadError }, extracted] = await Promise.all([
    supabase.storage
      .from(INVOICE_BUCKET)
      .upload(filePath, file, { contentType: file.type, upsert: false }),
    extractInvoiceFields(file),
  ]);

  if (uploadError) {
    throw new InvoiceIngestError(`Upload failed: ${uploadError.message}`);
  }

  // RULE: Flow never creates suppliers in QuickBooks. Match the OCR'd
  // vendor EXACTLY (normalized) against the read-only QBO mirror. An exact
  // match stores the canonical QBO name; no match keeps the OCR name but
  // flags the invoice (qbo_vendor_matched=false) so it's visibly marked
  // and can't sync until a human picks the right supplier.
  let matchedVendorName: string | null = null;
  if (extracted?.vendor_name) {
    // Paginated: PostgREST caps responses at 1000 rows, and the mirror has
    // 2,045 — matching against a truncated list would silently keep the
    // OCR name and break the QBO push later.
    const qboSuppliers = await fetchAllQboSuppliers(supabase, organizationId);
    matchedVendorName = matchSupplier(qboSuppliers, extracted.vendor_name);
  }
  const vendorName = matchedVendorName ?? extracted?.vendor_name ?? null;
  const qboVendorMatched = matchedVendorName !== null;

  // Dext/ApprovalMax-style: a saved supplier rule wins over whatever the
  // extraction guessed for the fields it covers — it's a business rule a
  // human configured on purpose, not a best-effort read of the document.
  const supplierDefaults = await getSupplierDefaults(
    supabase,
    organizationId,
    vendorName
  );

  // Project detection from the PO number: suppliers commonly put their job
  // number on the PO ("2022-589-PO-1234" starts with project code 2022-58).
  // Project is always a per-bill choice (a supplier can work on many jobs),
  // so it comes from the PO match, never from a supplier rule.
  let detectedProjectId: string | null = null;
  if (extracted?.po_number) {
    const { data: orgProjects } = await supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("source", "qbo")
      .eq("active", true);
    detectedProjectId = matchProjectFromPoNumber(
      orgProjects ?? [],
      extracted.po_number
    );
  }
  const projectId = detectedProjectId ?? null;

  // Build the line items with any supplier-rule overrides applied first,
  // then derive the invoice's amount/tax from THOSE final line items (tax
  // per line as amount × tax rate%, blank rate = no tax) — not the
  // document's own printed totals, and not the pre-override tax rates.
  // When extraction found no line items there's nothing to derive from,
  // so the whole-document totals are the only numbers available.
  // Supplier rules carry Category, Tax rate, Payment terms, Currency —
  // never Class or Project (those are per-bill choices).
  const hasLineItems = !!extracted && extracted.line_items.length > 0;
  const finalLineItems = hasLineItems
    ? extracted!.line_items.map((li) => ({
        description: li.description,
        amount: li.amount,
        tax_rate: supplierDefaults?.tax_rate ?? li.tax_rate,
        category: hbPayableCategoryFor(li) ?? supplierDefaults?.category ?? li.category,
        class: li.class,
        project_id: projectId,
      }))
    : supplierDefaults
      ? [
          {
            description: null,
            amount: extracted?.total_amount ?? null,
            tax_rate: supplierDefaults.tax_rate,
            category: supplierDefaults.category,
            class: null,
            project_id: projectId,
          },
        ]
      : [];

  const computedAmount = hasLineItems
    ? computeLineItemTotals(finalLineItems).total
    : (extracted?.total_amount ?? null);
  const computedTax = hasLineItems
    ? computeLineItemTotals(finalLineItems).tax
    : (extracted?.tax_amount ?? null);

  // Route the invoice to the first workflow whose items all match; fall
  // back to the org's default workflow.
  const { data: submitterProfile } = submittedBy
    ? await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", submittedBy)
        .maybeSingle()
    : { data: null };
  const workflowId = await selectWorkflowForInvoice(supabase, organizationId, {
    amount: computedAmount,
    vendorName,
    submittedBy: submittedBy ?? null,
    submitterName: submitterProfile?.full_name ?? null,
    projects: [], // project is assigned per line item later in the Bill panel
    lineItems: [],
  });

  const billDate = extracted?.bill_date ?? null;
  const dueDate =
    supplierDefaults?.payment_terms_days != null && billDate
      ? addDays(billDate, supplierDefaults.payment_terms_days)
      : (extracted?.due_date ?? null);

  const { data: invoice, error: insertError } = await supabase
    .from("invoices")
    .insert({
      organization_id: organizationId,
      workflow_id: workflowId,
      status: "on_review", // sits in the Pending Review queue until
      // Review Done routes it into the approval workflow
      source,
      source_email: sourceEmail ?? null,
      submitted_by: submittedBy ?? null,
      file_path: filePath,
      file_name: file.name,
      vendor_name: vendorName,
      qbo_vendor_matched: qboVendorMatched,
      invoice_number: extracted?.invoice_number ?? null,
      amount: computedAmount,
      currency: supplierDefaults?.currency ?? extracted?.currency ?? "USD",
      bill_date: billDate,
      due_date: dueDate,
      tax_amount: computedTax,
      extraction: (extracted ?? null) as Record<string, unknown> | null,
    })
    .select()
    .single();

  if (insertError || !invoice) {
    await supabase.storage.from(INVOICE_BUCKET).remove([filePath]);
    throw new InvoiceIngestError(
      `Could not create invoice record: ${insertError?.message ?? "unknown error"}`
    );
  }

  // Populate the Bill panel's Category details from the final line items.
  const lineItemsToInsert = finalLineItems.map((li, i) => ({
    ...li,
    invoice_id: invoice.id,
    line_order: i + 1,
  }));

  if (lineItemsToInsert.length > 0) {
    await supabase.from("invoice_line_items").insert(lineItemsToInsert);
  }

  await supabase.from("audit_log").insert({
    organization_id: organizationId,
    invoice_id: invoice.id,
    actor_id: submittedBy ?? null,
    action: source === "email" ? "invoice.received_by_email" : "invoice.uploaded",
    metadata: source === "email" ? { source_email: sourceEmail } : null,
  });

  return invoice;
}
