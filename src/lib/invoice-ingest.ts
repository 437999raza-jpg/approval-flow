import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, InvoiceSource } from "@/lib/supabase/types";
import { createInvoiceFromFile, InvoiceIngestError } from "@/lib/invoices";
import { classifyMultiPageInvoice } from "@/lib/invoice-split";

const INVOICE_BUCKET = "invoices";

export type IngestResult =
  | { kind: "invoice"; invoice: Database["public"]["Tables"]["invoices"]["Row"] }
  | { kind: "pending_split"; pendingSplitId: string; groupCount: number };

interface IngestArgs {
  supabase: SupabaseClient<Database>;
  organizationId: string;
  file: File;
  source: InvoiceSource;
  submittedBy?: string;
  sourceEmail?: string;
}

// Entry point for BOTH manual upload and inbound email: classifies a PDF
// upload before committing to "this is one invoice". A single-page file,
// an image, or a PDF classified as one invoice (with or without
// supporting pages) goes straight through the existing single-invoice
// pipeline unchanged. A PDF classified as multiple separate invoices
// instead lands in pending_invoice_splits for a human to review and
// confirm — see src/app/invoices/pending-splits. Authored by Araza.
export async function ingestInvoiceFile(args: IngestArgs): Promise<IngestResult> {
  const { supabase, organizationId, file, source, submittedBy, sourceEmail } = args;

  if (file.type === "application/pdf") {
    let bytes: Uint8Array | null = null;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      bytes = null;
    }
    const groups = bytes ? await classifyMultiPageInvoice(bytes) : null;

    if (groups && groups.length > 1 && bytes) {
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const filePath = `${organizationId}/pending-splits/${crypto.randomUUID()}-${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from(INVOICE_BUCKET)
        .upload(filePath, bytes, { contentType: file.type, upsert: false });
      if (uploadError) {
        throw new InvoiceIngestError(`Upload failed: ${uploadError.message}`);
      }

      const pageCount = groups.reduce((n, g) => n + g.pages.length, 0);
      const { data: pending, error: insertError } = await supabase
        .from("pending_invoice_splits")
        .insert({
          organization_id: organizationId,
          source,
          source_email: sourceEmail ?? null,
          submitted_by: submittedBy ?? null,
          file_path: filePath,
          file_name: file.name,
          page_count: pageCount,
          groups,
        })
        .select("id")
        .single();
      if (insertError || !pending) {
        await supabase.storage.from(INVOICE_BUCKET).remove([filePath]);
        throw new InvoiceIngestError(
          `Could not record the multi-invoice upload: ${insertError?.message ?? "unknown error"}`
        );
      }

      return { kind: "pending_split", pendingSplitId: pending.id, groupCount: groups.length };
    }
  }

  const invoice = await createInvoiceFromFile({
    supabase,
    organizationId,
    file,
    source,
    submittedBy,
    sourceEmail,
  });
  return { kind: "invoice", invoice };
}
