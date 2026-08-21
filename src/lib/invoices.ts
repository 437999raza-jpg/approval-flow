import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, InvoiceSource } from "@/lib/supabase/types";
import { extractInvoiceFields } from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";
import { normalizeForMatching } from "@/lib/matching";
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

  // Dext/ApprovalMax-style: a saved supplier rule wins over whatever the
  // extraction guessed for the fields it covers — it's a business rule a
  // human configured on purpose, not a best-effort read of the document.
  const supplierDefaults = await getSupplierDefaults(
    supabase,
    organizationId,
    extracted?.vendor_name ?? null
  );

  // Build the line items with any supplier-rule overrides applied first,
  // then derive the invoice's amount/tax from THOSE final line items (tax
  // per line as amount × tax rate%, blank rate = no tax) — not the
  // document's own printed totals, and not the pre-override tax rates.
  // When extraction found no line items there's nothing to derive from,
  // so the whole-document totals are the only numbers available.
  const hasLineItems = !!extracted && extracted.line_items.length > 0;
  const finalLineItems = hasLineItems
    ? extracted!.line_items.map((li) => ({
        description: li.description,
        amount: li.amount,
        tax_rate: supplierDefaults?.tax_rate ?? li.tax_rate,
        category: supplierDefaults?.category ?? li.category,
        class: supplierDefaults?.class ?? li.class,
        project_id: supplierDefaults?.project_id ?? null,
      }))
    : supplierDefaults
      ? [
          {
            description: null,
            amount: extracted?.total_amount ?? null,
            tax_rate: supplierDefaults.tax_rate,
            category: supplierDefaults.category,
            class: supplierDefaults.class,
            project_id: supplierDefaults.project_id,
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
    vendorName: extracted?.vendor_name ?? null,
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
      vendor_name: extracted?.vendor_name ?? null,
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
