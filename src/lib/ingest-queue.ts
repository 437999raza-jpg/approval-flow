import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { ingestInvoiceFile } from "@/lib/invoice-ingest";
import { NO_INVOICE_DATA_ERROR } from "@/lib/invoices";

// Async ingestion queue. Uploads/emails no longer wait inline on the 20-60s
// OpenRouter extraction: the route/webhook uploads the bytes to a staging
// path, records a queued ingest_jobs row (plus the upload_log /
// inbound_email_log display row), and returns instantly. The UI's
// /api/ingest/process poller then calls runNextIngestJob() — which pops the
// oldest queued job for the org, runs the NORMAL ingest pipeline, writes
// the outcome to the display tables, and cleans up the staging file.
// Swapping in Vercel Cron / Inngest later = calling runNextIngestJob from
// a scheduled job instead of the poller.

export const STAGING_BUCKET = "invoices";
export const STAGING_PREFIX = "ingest-staging";

type Supabase = SupabaseClient<Database>;

export interface EnqueueArgs {
  supabase: Supabase;
  organizationId: string;
  file: { name: string; type: string; size: number; bytes: Uint8Array };
  source: "manual" | "email";
  submittedBy?: string | null;
  sourceEmail?: string | null;
  uploadLogId?: string | null;
  inboundEmailLogId?: string | null;
}

// Upload the bytes to staging and insert a queued job. Returns the job id.
export async function enqueueIngestJob(
  args: EnqueueArgs
): Promise<string | null> {
  const safeName = args.file.name.replace(/[^\w.\-]+/g, "_");
  const stagingPath = `${args.organizationId}/${STAGING_PREFIX}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await args.supabase.storage
    .from(STAGING_BUCKET)
    .upload(stagingPath, args.file.bytes, {
      contentType: args.file.type,
      upsert: false,
    });
  if (uploadError) {
    console.error("enqueueIngestJob staging upload failed:", uploadError);
    return null;
  }

  const { data, error } = await args.supabase
    .from("ingest_jobs")
    .insert({
      organization_id: args.organizationId,
      staging_path: stagingPath,
      file_name: args.file.name,
      mime_type: args.file.type,
      file_size_bytes: args.file.size,
      source: args.source,
      submitted_by: args.submittedBy ?? null,
      source_email: args.sourceEmail ?? null,
      upload_log_id: args.uploadLogId ?? null,
      inbound_email_log_id: args.inboundEmailLogId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("enqueueIngestJob insert failed:", error);
    await args.supabase.storage.from(STAGING_BUCKET).remove([stagingPath]);
    return null;
  }
  return data.id;
}

export interface ProcessResult {
  ran: boolean; // whether a job was processed this call
  pending: number; // queued jobs remaining for the org
}

// Pop the oldest queued job for the org and process it: download staging →
// normal ingest pipeline (ingestInvoiceFile) → write the outcome to
// upload_log / inbound_email_log → remove staging. Retries failed jobs up to
// 3 attempts (back to 'queued' between tries). Best-effort — never throws.
export async function runNextIngestJob(
  supabase: Supabase,
  organizationId: string
): Promise<ProcessResult> {
  const { data: job } = await supabase
    .from("ingest_jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!job) {
    return { ran: false, pending: 0 };
  }

  await supabase
    .from("ingest_jobs")
    .update({
      status: "processing",
      attempt_count: (job.attempt_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  const fail = async (message: string) => {
    const attempts = (job.attempt_count ?? 0) + 1;
    const terminal = attempts >= 3;
    await supabase
      .from("ingest_jobs")
      .update({
        status: terminal ? "error" : "queued",
        last_error: message,
        processed_at: terminal ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    // Keep the staging file on terminal failure so the Queue's Reprocess
    // button can re-run the job (90-day cleanup removes stale files).
    // Reflect the failure in the display tables.
    if (job.upload_log_id) {
      await supabase
        .from("upload_log")
        .update({
          status: "error",
          error: message,
          processed_at: new Date().toISOString(),
        })
        .eq("id", job.upload_log_id);
    }
    if (job.inbound_email_log_id) {
      await supabase
        .from("inbound_email_log")
        .update({
          processing: false,
          error: message,
        })
        .eq("id", job.inbound_email_log_id);
    }
  };

  try {
    const { data: blob, error: downloadError } = await supabase.storage
      .from(STAGING_BUCKET)
      .download(job.staging_path);
    if (downloadError || !blob) {
      await fail(`Could not read the uploaded file: ${downloadError?.message ?? "unknown"}`);
      return { ran: true, pending: await queuedCount(supabase, organizationId) };
    }

    const file = new File([await blob.arrayBuffer()], job.file_name, {
      type: job.mime_type || "application/octet-stream",
    });

    // Email subject as extra extraction context (e.g. "Invoice 26-2400" —
    // a number that appears only in the subject can help the model).
    let extraContext: string | undefined;
    if (job.inbound_email_log_id) {
      const { data: emailRow } = await supabase
        .from("inbound_email_log")
        .select("subject")
        .eq("id", job.inbound_email_log_id)
        .maybeSingle();
      extraContext = emailRow?.subject ?? undefined;
    }

    const result = await ingestInvoiceFile({
      supabase,
      organizationId,
      file,
      source: job.source === "email" ? "email" : "manual",
      submittedBy: job.submitted_by ?? undefined,
      sourceEmail: job.source_email ?? undefined,
      extraContext,
    });

    const processedAt = new Date().toISOString();

    if (job.upload_log_id) {
      if (result.kind === "pending_split") {
        await supabase
          .from("upload_log")
          .update({
            status: "split",
            pending_split_id: result.pendingSplitId,
            processed_at: processedAt,
          })
          .eq("id", job.upload_log_id);
      } else {
        await supabase
          .from("upload_log")
          .update({
            status: "done",
            invoice_id: result.invoice.id,
            processed_at: processedAt,
          })
          .eq("id", job.upload_log_id);
      }
    }

    if (job.inbound_email_log_id) {
      // Append (multiple jobs can share one email log row when the merge
      // fell back to per-file ingestion).
      const { data: logRow } = await supabase
        .from("inbound_email_log")
        .select("invoice_ids, pending_split_ids")
        .eq("id", job.inbound_email_log_id)
        .maybeSingle();
      const existingInv = (logRow?.invoice_ids ?? []) as string[];
      const existingSplit = (logRow?.pending_split_ids ?? []) as string[];
      const patch: Partial<
        Database["public"]["Tables"]["inbound_email_log"]["Row"]
      > = {
        processing: false,
        error: null,
      };
      if (result.kind === "pending_split") {
        patch.pending_split_ids = [...existingSplit, result.pendingSplitId];
      } else {
        patch.invoice_ids = [...existingInv, result.invoice.id];
      }
      patch.processed =
        (patch.invoice_ids?.length ?? 0) > 0 ||
        (patch.pending_split_ids?.length ?? 0) > 0;
      await supabase
        .from("inbound_email_log")
        .update(patch)
        .eq("id", job.inbound_email_log_id);
    }

    await supabase
      .from("ingest_jobs")
      .update({
        status: "done",
        last_error: null,
        processed_at: processedAt,
        updated_at: processedAt,
      })
      .eq("id", job.id);
    await supabase.storage.from(STAGING_BUCKET).remove([job.staging_path]);

    return { ran: true, pending: await queuedCount(supabase, organizationId) };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown ingest error";
    if (message === NO_INVOICE_DATA_ERROR) {
      // The document clearly isn't an invoice — not a retryable failure.
      // Surface it as "No invoice data found" in the queue so the admin can
      // delete it; never create a junk invoice (see createInvoiceFromFile).
      const now = new Date().toISOString();
      await supabase
        .from("ingest_jobs")
        .update({ status: "done", last_error: message, processed_at: now, updated_at: now })
        .eq("id", job.id);
      // Keep the staging file so the Queue's Reprocess button can re-run
      // this document (90-day cleanup removes stale files).
      if (job.upload_log_id) {
        await supabase
          .from("upload_log")
          .update({ status: "no_invoice", error: message, processed_at: now })
          .eq("id", job.upload_log_id);
      }
      if (job.inbound_email_log_id) {
        await supabase
          .from("inbound_email_log")
          .update({ processing: false, processed: false, error: message })
          .eq("id", job.inbound_email_log_id);
      }
    } else {
      await fail(message);
    }
    return { ran: true, pending: await queuedCount(supabase, organizationId) };
  }
}

async function queuedCount(supabase: Supabase, organizationId: string) {
  const { count } = await supabase
    .from("ingest_jobs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "queued");
  return count ?? 0;
}
