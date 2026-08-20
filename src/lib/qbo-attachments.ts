import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { buildInvoiceAuditDocument } from "@/lib/audit-trail";

// The exact files that get attached to the QuickBooks bill when an
// approved invoice syncs:
//   1. audit-trail-<vendor>-<id>.pdf  — chat history + approval audit trail
//   2. the primary invoice document (invoices.file_path)
//   3. every additional document page (invoice_documents, migration 0003)
// All are returned as bytes ready for QBO's multipart attachment upload.
// Authored by Araza.

export interface QboAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

async function downloadToAttachment(
  supabase: SupabaseClient<Database>,
  filePath: string,
  name: string
): Promise<QboAttachment | null> {
  const { data: blob, error } = await supabase.storage
    .from("invoices")
    .download(filePath);
  if (error || !blob) return null;
  return {
    name,
    mimeType: mimeFor(name),
    data: new Uint8Array(await blob.arrayBuffer()),
  };
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

  // 2) The primary invoice document.
  const primary = await downloadToAttachment(
    supabase,
    invoice.file_path,
    invoice.file_name
  );
  if (primary) attachments.push(primary);

  // 3) Every additional document page.
  const { data: extraDocs } = await supabase
    .from("invoice_documents")
    .select("file_path, file_name")
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: true });
  for (const doc of extraDocs ?? []) {
    const extra = await downloadToAttachment(
      supabase,
      doc.file_path,
      doc.file_name
    );
    if (extra) attachments.push(extra);
  }

  return attachments.length > 0 ? attachments : null;
}
