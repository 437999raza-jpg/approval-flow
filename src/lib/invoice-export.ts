import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { mergeDocuments } from "@/lib/merge-documents";
import { buildInvoiceAuditDocument } from "@/lib/audit-trail";

// Shared by the batch PDF export route, the batch email action, and the
// Reports page's downloads: fetch every selected invoice's documents
// (primary file + any extra pages) and merge them into ONE PDF, in
// invoice order. Authored by Araza.

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

type MergeFile = { name: string; type: string; bytes: Uint8Array };

// Downloads each invoice's primary document + any extra pages, in
// created_at order — the shared fetch behind both buildMergedInvoicePdf
// and buildAuditPlusInvoicesPdf below, so both stay in the same invoice
// order without duplicating the storage-download logic.
async function loadInvoiceFiles(
  supabase: SupabaseClient<Database>,
  invoiceIds: string[]
): Promise<{ invoiceId: string; files: MergeFile[] }[]> {
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, file_path, file_name")
    .in("id", invoiceIds)
    .order("created_at", { ascending: true });
  if (!invoices || invoices.length === 0) return [];

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

  const out: { invoiceId: string; files: MergeFile[] }[] = [];
  for (const inv of invoices) {
    const files: MergeFile[] = [];
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
    out.push({ invoiceId: inv.id, files });
  }
  return out;
}

// This is what "export all the PDFs as one file" and "send by email" both
// use — one file, one email. Returns null when no documents could be
// downloaded at all.
export async function buildMergedInvoicePdf(
  supabase: SupabaseClient<Database>,
  invoiceIds: string[]
): Promise<Uint8Array | null> {
  if (invoiceIds.length === 0) return null;
  const perInvoice = await loadInvoiceFiles(supabase, invoiceIds);
  const files = perInvoice.flatMap((i) => i.files);
  if (files.length === 0) return null;
  return mergeDocuments(files);
}

// The Reports page's "Download audit report + invoices" — per invoice,
// its audit PDF (buildInvoiceAuditDocument) followed by its original
// document(s), for every invoice in the report's result set, all merged
// into ONE file. Mirrors what already happens at QBO-sync time, where
// the audit PDF and the original document are attached to the bill as a
// pair (see audit-trail.ts's own comment) — this is that same pairing,
// just for many invoices at once instead of one.
export async function buildAuditPlusInvoicesPdf(
  supabase: SupabaseClient<Database>,
  invoiceIds: string[]
): Promise<Uint8Array | null> {
  if (invoiceIds.length === 0) return null;
  const perInvoice = await loadInvoiceFiles(supabase, invoiceIds);
  if (perInvoice.length === 0) return null;

  const files: MergeFile[] = [];
  for (const { invoiceId, files: docFiles } of perInvoice) {
    const audit = await buildInvoiceAuditDocument(supabase, invoiceId);
    if (audit) {
      files.push({ name: audit.filename, type: "application/pdf", bytes: new Uint8Array(audit.pdf) });
    }
    files.push(...docFiles);
  }
  if (files.length === 0) return null;
  return mergeDocuments(files);
}
