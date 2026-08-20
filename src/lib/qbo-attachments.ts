import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { buildInvoiceAuditDocument } from "@/lib/audit-trail";

// The exact two files that get attached to the QuickBooks bill when an
// approved invoice syncs:
//   1. audit-trail-<vendor>-<id>.pdf  — chat history + approval audit trail
//   2. <original file>                — the invoice document itself
// Both are returned as bytes ready for QBO's multipart attachment upload.
// Authored by Araza.

export interface QboAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export async function buildQboAttachmentBundle(
  supabase: SupabaseClient<Database>,
  invoiceId: string
): Promise<QboAttachment[] | null> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, vendor_name, file_path, file_name")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return null;

  const attachments: QboAttachment[] = [];

  // 1) Audit PDF (chat history + approval audit trail).
  const audit = await buildInvoiceAuditDocument(supabase, invoiceId);
  if (audit) {
    attachments.push({
      name: audit.filename,
      mimeType: "application/pdf",
      data: new Uint8Array(audit.pdf),
    });
  }

  // 2) The original invoice document.
  const { data: blob, error } = await supabase.storage
    .from("invoices")
    .download(invoice.file_path);
  if (!error && blob) {
    const isPdf = invoice.file_name.toLowerCase().endsWith(".pdf");
    attachments.push({
      name: invoice.file_name,
      mimeType: isPdf ? "application/pdf" : "application/octet-stream",
      data: new Uint8Array(await blob.arrayBuffer()),
    });
  }

  return attachments.length > 0 ? attachments : null;
}
