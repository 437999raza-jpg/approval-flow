import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { mergeDocuments } from "@/lib/merge-documents";

// Shared by the batch PDF export route and the batch email action: download
// every selected invoice's documents (primary file + any extra pages) and
// merge them ALL into ONE PDF, in invoice order. This is what "export all
// the PDFs as one file" and "send by email" both use — one file, one email.
// Returns null when no documents could be downloaded at all. Authored by
// Araza.

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function mimeFor(name: string, fallback: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? fallback;
}

export async function buildMergedInvoicePdf(
  supabase: SupabaseClient<Database>,
  invoiceIds: string[]
): Promise<Uint8Array | null> {
  if (invoiceIds.length === 0) return null;

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, file_path, file_name")
    .in("id", invoiceIds)
    .order("created_at", { ascending: true });
  if (!invoices || invoices.length === 0) return null;

  const { data: extraDocs } = await supabase
    .from("invoice_documents")
    .select("invoice_id, file_path, file_name")
    .in("invoice_id", invoiceIds)
    .order("created_at", { ascending: true });
  const extraByInvoice = new Map<string, typeof extraDocs>();
  for (const d of extraDocs ?? []) {
    if (!extraByInvoice.has(d.invoice_id)) extraByInvoice.set(d.invoice_id, []);
    extraByInvoice.get(d.invoice_id)!.push(d);
  }

  // Primary document first per invoice, then its extra pages — one
  // invoice's full set is kept together in the merged file.
  const files: { name: string; type: string; bytes: Uint8Array }[] = [];
  for (const inv of invoices) {
    const { data: blob, error } = await supabase.storage
      .from("invoices")
      .download(inv.file_path);
    if (!error && blob) {
      files.push({
        name: inv.file_name,
        type: mimeFor(inv.file_name, "application/octet-stream"),
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    for (const d of extraByInvoice.get(inv.id) ?? []) {
      const { data: extraBlob, error: extraError } = await supabase.storage
        .from("invoices")
        .download(d.file_path);
      if (!extraError && extraBlob) {
        files.push({
          name: d.file_name,
          type: mimeFor(d.file_name, "application/octet-stream"),
          bytes: new Uint8Array(await extraBlob.arrayBuffer()),
        });
      }
    }
  }

  if (files.length === 0) return null;
  return mergeDocuments(files);
}
