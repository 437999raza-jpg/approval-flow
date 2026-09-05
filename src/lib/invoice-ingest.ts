import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, InvoiceSource } from "@/lib/supabase/types";
import { createInvoiceFromFile, InvoiceIngestError, validateInvoiceFile } from "@/lib/invoices";
import { classifyMultiPageInvoice } from "@/lib/invoice-split";
import { pdfPageCount } from "@/lib/merge-documents";

const INVOICE_BUCKET = "invoices";

// [1M]/[NM] override: one group per page (no classifier hints) so the
// reviewer confirms/adjusts the ranges. Empty when the file can't be split
// (single page) — the caller then falls back to normal ingestion.
async function pagePerGroup(bytes: Uint8Array) {
  const n = pdfPageCount(bytes);
  if (n <= 1) return [];
  return Array.from({ length: n }, (_, i) => ({
    pages: [i],
    vendorHint: null as string | null,
    invoiceNumberHint: null as string | null,
  }));
}

export type IngestResult =
  | { kind: "invoice"; invoice: Database["public"]["Tables"]["invoices"]["Row"] }
  | { kind: "pending_split"; pendingSplitId: string; groupCount: number };

interface IngestArgs {
  supabase: SupabaseClient<Database>;
  organizationId: string;
  file: File;
  // Narrower than the full InvoiceSource (migration 0120 added
  // "qbo_import") on purpose — this pipeline classifies/splits a
  // just-uploaded file, which a bulk QBO bill import never goes
  // through (it writes already-structured invoices directly, see
  // qbo-bill-import.ts). pending_invoice_splits.source is typed to
  // match this same pair, not the full InvoiceSource union.
  source: Exclude<InvoiceSource, "qbo_import">;
  submittedBy?: string;
  sourceEmail?: string;
  extraContext?: string; // e.g. the inbound email subject
  // [1M]/[NM] subject codes: force this PDF into split review (one group
  // per page, reviewer confirms/adjusts) even if the classifier wouldn't
  // have flagged it as multiple invoices.
  forceSplit?: boolean;
}

// Entry point for BOTH manual upload and inbound email: classifies a PDF
// upload before committing to "this is one invoice". A single-page file,
// an image, or a PDF classified as one invoice (with or without
// supporting pages) goes straight through the existing single-invoice
// pipeline unchanged. A PDF classified as multiple separate invoices
// instead lands in pending_invoice_splits for a human to review and
// confirm — see src/app/invoices/pending-splits. Authored by Araza.
export async function ingestInvoiceFile(args: IngestArgs): Promise<IngestResult> {
  const { supabase, organizationId, file, source, submittedBy, sourceEmail, extraContext, forceSplit } = args;
  validateInvoiceFile(file);

  if (file.type === "application/pdf") {
    let bytes: Uint8Array | null = null;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      bytes = null;
    }

    // [1M]/[NM] override: the sender says this file contains multiple
    // invoices — put EVERY page into its own group and let the reviewer
    // confirm/adjust, instead of trusting the classifier.
    if (forceSplit && bytes) {
      const groups = await pagePerGroup(bytes);
      if (groups.length > 1) {
        const safeName = file.name.replace(/[^\w.\-]+/g, "_");
        const filePath = `${organizationId}/pending-splits/${crypto.randomUUID()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from(INVOICE_BUCKET)
          .upload(filePath, bytes, { contentType: file.type, upsert: false });
        if (uploadError) {
          throw new InvoiceIngestError(`Upload failed: ${uploadError.message}`);
        }
        const { data: pending, error: insertError } = await supabase
          .from("pending_invoice_splits")
          .insert({
            organization_id: organizationId,
            source,
            source_email: sourceEmail ?? null,
            submitted_by: submittedBy ?? null,
            file_path: filePath,
            file_name: file.name,
            page_count: groups.length,
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

    const groups = bytes ? await classifyMultiPageInvoice(bytes, organizationId) : null;

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
    extraContext,
  });
  return { kind: "invoice", invoice };
}
