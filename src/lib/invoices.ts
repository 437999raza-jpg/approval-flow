import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, InvoiceSource } from "@/lib/supabase/types";
import { extractInvoiceFields } from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";

const INVOICE_BUCKET = "invoices";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export class InvoiceIngestError extends Error {}

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
    amount: extracted?.total_amount ?? null,
    vendorName: extracted?.vendor_name ?? null,
    submittedBy: submittedBy ?? null,
    submitterName: submitterProfile?.full_name ?? null,
    projectId: null, // project is assigned later in the Bill panel
    projectName: null,
    lineItems: [],
  });

  const { data: invoice, error: insertError } = await supabase
    .from("invoices")
    .insert({
      organization_id: organizationId,
      workflow_id: workflowId,
      status: "pending",
      source,
      source_email: sourceEmail ?? null,
      submitted_by: submittedBy ?? null,
      file_path: filePath,
      file_name: file.name,
      vendor_name: extracted?.vendor_name ?? null,
      invoice_number: extracted?.invoice_number ?? null,
      amount: extracted?.total_amount ?? null,
      currency: extracted?.currency ?? "USD",
      bill_date: extracted?.bill_date ?? null,
      due_date: extracted?.due_date ?? null,
      tax_amount: extracted?.tax_amount ?? null,
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

  // Populate the Bill panel's Category details from the extracted line
  // items (best-effort).
  if (extracted && extracted.line_items.length > 0) {
    await supabase.from("invoice_line_items").insert(
      extracted.line_items.map((li, i) => ({
        invoice_id: invoice.id,
        description: li.description,
        amount: li.amount,
        tax_rate: li.tax_rate,
        category: li.category,
        class: li.class,
        line_order: i + 1,
      }))
    );
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
