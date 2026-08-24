// Vercel Hobby caps configurable duration at 60s — the
// OpenRouter extraction call can take 20-60s.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { InvoiceIngestError } from "@/lib/invoices";
import { ingestInvoiceFile } from "@/lib/invoice-ingest";
import type { Database } from "@/lib/supabase/types";

// Manual upload path: signed-in user clicks "Add invoice" / drags a file in.
// A multi-page PDF classified as several separate invoices doesn't create
// anything yet — it lands in pending_invoice_splits for review instead.
//
// Every upload is recorded in upload_log (migration 0054) with its outcome
// and processing time, so the Add-invoice page can show "Recent uploads"
// and future reporting can measure how extraction/OCR and the queue
// perform. Log rows older than 90 days are cleaned up opportunistically so
// the queue never grows into thousands of rows.
export async function POST(request: Request) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const org = await getCurrentOrg(supabase);
  if (!org) {
    return NextResponse.json({ error: "No organization" }, { status: 400 });
  }
  if (org.role === "auditor") {
    return NextResponse.json(
      { error: "Auditors are read-only and can't add invoices." },
      { status: 403 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  // Best-effort: never fail an upload because logging/cleanup failed.
  type UploadLogPatch = { status: "done" | "split" | "error" } & Partial<
    Database["public"]["Tables"]["upload_log"]["Row"]
  >;
  const logUpload = async (row: UploadLogPatch) => {
    const { error } = await supabase.from("upload_log").insert({
      organization_id: org.id,
      user_id: user.id,
      filename: file.name,
      file_type: file.type,
      file_size_bytes: file.size,
      ...row,
    });
    if (error) console.error("upload_log insert failed:", error);
  };
  const cleanupOldLogs = async () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const admin = createAdminClient(); // bypass RLS for cleanup
    await admin
      .from("upload_log")
      .delete()
      .eq("organization_id", org.id)
      .lt("created_at", cutoff);
    await admin
      .from("inbound_email_log")
      .delete()
      .eq("organization_id", org.id)
      .lt("created_at", cutoff);
  };

  const startedAt = Date.now();
  const finish = async (patch: UploadLogPatch) => {
    await logUpload({
      ...patch,
      created_at: new Date(startedAt).toISOString(),
      processed_at: new Date().toISOString(),
    });
    await cleanupOldLogs();
  };

  try {
    const result = await ingestInvoiceFile({
      supabase,
      organizationId: org.id,
      file,
      source: "manual",
      submittedBy: user.id,
    });
    if (result.kind === "pending_split") {
      await finish({
        status: "split",
        pending_split_id: result.pendingSplitId,
      });
      return NextResponse.json(
        { pendingSplitId: result.pendingSplitId, groupCount: result.groupCount },
        { status: 202 }
      );
    }
    await finish({ status: "done", invoice_id: result.invoice.id });
    return NextResponse.json({ invoice: result.invoice }, { status: 201 });
  } catch (err) {
    if (err instanceof InvoiceIngestError) {
      await finish({ status: "error", error: err.message });
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    await finish({
      status: "error",
      error: err instanceof Error ? err.message : "Unknown error",
    });
    throw err;
  }
}
