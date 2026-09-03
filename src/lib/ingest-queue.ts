import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { ingestInvoiceFile } from "@/lib/invoice-ingest";
import { NO_INVOICE_DATA_ERROR } from "@/lib/invoices";
import { officeDocKind, convertOfficeDocToPdf } from "@/lib/office-to-pdf";
import { mergeDocuments } from "@/lib/merge-documents";
import { sendInvoiceReceiptEmail } from "@/lib/notify";

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
  // [1N]/[NM] subject-code decision — force this document into split
  // review regardless of what the classifier would otherwise decide.
  forceSplit?: boolean;
}

// Upload the bytes to staging and insert a queued job. Returns the job id.
export async function enqueueIngestJob(
  args: EnqueueArgs
): Promise<string | null> {
  // A Word/Excel invoice converted to a real PDF right here, before
  // anything else sees it — the extractor, the split-review page count
  // and the document viewer only ever speak PDF/image, so this is the
  // one place a second input format needs to be taught in, rather than
  // every downstream consumer. See office-to-pdf.tsx.
  let file = args.file;
  if (officeDocKind(file.name, file.type)) {
    const pdfBytes = await convertOfficeDocToPdf(file.bytes, file.name, file.type);
    if (!pdfBytes) {
      console.error(`enqueueIngestJob: could not convert "${file.name}" to PDF`);
      return null;
    }
    const stem = file.name.replace(/\.[^.]+$/, "") || "document";
    file = { name: `${stem}.pdf`, type: "application/pdf", size: pdfBytes.length, bytes: pdfBytes };
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const stagingPath = `${args.organizationId}/${STAGING_PREFIX}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await args.supabase.storage
    .from(STAGING_BUCKET)
    .upload(stagingPath, file.bytes, {
      contentType: file.type,
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
      file_name: file.name,
      mime_type: file.type,
      file_size_bytes: file.size,
      source: args.source,
      submitted_by: args.submittedBy ?? null,
      source_email: args.sourceEmail ?? null,
      upload_log_id: args.uploadLogId ?? null,
      inbound_email_log_id: args.inboundEmailLogId ?? null,
      force_split: args.forceSplit ?? false,
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
// A job that got claimed (status='processing') but never finished — the
// function that claimed it was killed (e.g. Vercel's hard 60s cap) before
// it could mark it done/failed. Left alone it's stuck forever:
// runNextIngestJob only ever looks for status='queued'. Reset it back to
// queued for a natural retry, or — once it's already used up its 3
// attempts — fail it terminally the same way an in-process failure would,
// so it surfaces in the Queue instead of silently vanishing. 5 minutes is
// generous: a real ingest (download + one extraction call) normally
// finishes in well under a minute.
async function resetStaleIngestJobs(supabase: Supabase, organizationId: string) {
  const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: stuck } = await supabase
    .from("ingest_jobs")
    .select("id, attempt_count, upload_log_id, inbound_email_log_id")
    .eq("organization_id", organizationId)
    .eq("status", "processing")
    .lt("updated_at", staleCutoff);
  for (const job of stuck ?? []) {
    if ((job.attempt_count ?? 0) >= 3) {
      const message = "Processing was interrupted repeatedly and gave up after 3 attempts.";
      const now = new Date().toISOString();
      await supabase
        .from("ingest_jobs")
        .update({ status: "error", last_error: message, processed_at: now, updated_at: now })
        .eq("id", job.id);
      if (job.upload_log_id) {
        await supabase
          .from("upload_log")
          .update({ status: "error", error: message, processed_at: now })
          .eq("id", job.upload_log_id);
      }
      if (job.inbound_email_log_id) {
        await supabase
          .from("inbound_email_log")
          .update({ processing: false, error: message })
          .eq("id", job.inbound_email_log_id);
      }
    } else {
      await supabase
        .from("ingest_jobs")
        .update({ status: "queued", updated_at: new Date().toISOString() })
        .eq("id", job.id);
    }
  }
}

// Whether some OTHER job sharing this email log row is still queued or
// mid-flight. Every attachment on an email gets its own job now, so a
// 4-attachment email means 4 jobs sharing one inbound_email_log row —
// without this check, the FIRST one to finish would flip the row to
// "not processing" (and "processed") while the other 3 are still in
// flight, misrepresenting the email as done when it's only partially so.
async function otherActiveJobsExist(
  supabase: Supabase,
  emailLogId: string,
  excludeJobId: string
): Promise<boolean> {
  const { count } = await supabase
    .from("ingest_jobs")
    .select("id", { count: "exact", head: true })
    .eq("inbound_email_log_id", emailLogId)
    .in("status", ["queued", "processing"])
    .neq("id", excludeJobId);
  return (count ?? 0) > 0;
}

// An email with no subject code often carries one real invoice plus its
// own backup material — a WSIB clearance certificate, a certificate of
// insurance, a cover letter — none of which extract as invoices, so
// they used to just sit rejected with nothing pointing at them: "the
// insurance and the WSIB and any doc needs to be part of the
// package...PMs need to see these docs." Once every attachment on the
// email has finished (the caller checks this), fold anything that
// failed with NO_INVOICE_DATA_ERROR into the SOLE resulting invoice's
// own document as extra pages — reusing the existing reorder/delete-
// pages tool as how a reviewer discards ones they don't want kept,
// rather than inventing a second, separate "attachments" concept.
//
// Deliberately scoped to exactly one resulting invoice: with zero,
// there is nothing to attach a stray certificate to; with two or more,
// each could belong to either invoice, and guessing wrong would be
// worse than leaving today's per-attachment behavior alone.
async function foldBackupDocsIntoSoleInvoice(
  supabase: Supabase,
  inboundEmailLogId: string
): Promise<void> {
  const { data: logRow } = await supabase
    .from("inbound_email_log")
    .select("invoice_ids")
    .eq("id", inboundEmailLogId)
    .maybeSingle();
  const invoiceIds = (logRow?.invoice_ids ?? []) as string[];
  if (invoiceIds.length !== 1) return;
  const invoiceId = invoiceIds[0];

  const { data: backupJobs } = await supabase
    .from("ingest_jobs")
    .select("id, staging_path, file_name, mime_type")
    .eq("inbound_email_log_id", inboundEmailLogId)
    .eq("last_error", NO_INVOICE_DATA_ERROR);
  if (!backupJobs || backupJobs.length === 0) return;

  const { data: invoice } = await supabase
    .from("invoices")
    .select("file_path, file_name, organization_id")
    .eq("id", invoiceId)
    .maybeSingle();
  // Only a PDF has "pages" to append to — an invoice whose own document
  // is a plain image (a photographed receipt, say) has no merge target.
  if (!invoice || !invoice.file_name.toLowerCase().endsWith(".pdf")) return;

  const { data: mainBlob } = await supabase.storage.from("invoices").download(invoice.file_path);
  if (!mainBlob) return;

  const parts: { name: string; type: string; bytes: Uint8Array }[] = [
    { name: invoice.file_name, type: "application/pdf", bytes: new Uint8Array(await mainBlob.arrayBuffer()) },
  ];
  const foldedJobIds: string[] = [];
  const foldedStagingPaths: string[] = [];
  for (const job of backupJobs) {
    const { data: blob } = await supabase.storage.from(STAGING_BUCKET).download(job.staging_path);
    if (!blob) continue;
    parts.push({
      name: job.file_name,
      type: job.mime_type || "application/pdf",
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
    foldedJobIds.push(job.id);
    foldedStagingPaths.push(job.staging_path);
  }
  if (foldedJobIds.length === 0) return;

  const merged = await mergeDocuments(parts);
  if (!merged) return;

  const { error: uploadError } = await supabase.storage
    .from("invoices")
    .upload(invoice.file_path, merged, { contentType: "application/pdf", upsert: true });
  if (uploadError) {
    console.error("foldBackupDocsIntoSoleInvoice upload failed:", uploadError);
    return;
  }

  // Distinguish "folded into the invoice" from a plain no-invoice
  // rejection so a re-run of this reconciliation (another attachment on
  // the same email finishing later) never merges the same pages twice.
  await supabase
    .from("ingest_jobs")
    .update({ last_error: `${NO_INVOICE_DATA_ERROR} — merged into the invoice as extra pages` })
    .in("id", foldedJobIds);
  await supabase.storage.from(STAGING_BUCKET).remove(foldedStagingPaths);

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: null,
    action: "invoice.backup_docs_merged",
    metadata: { files: backupJobs.filter((j) => foldedJobIds.includes(j.id)).map((j) => j.file_name) },
  });
}

// "Confirming receipt of invoice" (reported live) — a receipt sent back
// to whoever an email came from, once every attachment on it has
// settled AND it actually produced at least one invoice (an email that
// turned out to be all backup material with nothing recognized gets no
// receipt — there's nothing to confirm). One per email, not per
// invoice or per attachment: receipt_ack_sent guards against the
// reconciliation running more than once for the same email (each
// sibling attachment finishing can trigger it).
async function sendReceiptAcknowledgment(
  supabase: Supabase,
  inboundEmailLogId: string
): Promise<void> {
  const { data: logRow } = await supabase
    .from("inbound_email_log")
    .select("invoice_ids, from_address, receipt_ack_sent, organization_id")
    .eq("id", inboundEmailLogId)
    .maybeSingle();
  if (!logRow || logRow.receipt_ack_sent || !logRow.from_address || !logRow.organization_id) return;
  const invoiceIds = (logRow.invoice_ids ?? []) as string[];
  if (invoiceIds.length === 0) return;

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", logRow.organization_id)
    .maybeSingle();

  // Marked sent BEFORE the actual send, not after — this only ever runs
  // once per email regardless of whether the send itself succeeds, same
  // tradeoff every other best-effort notification in this app makes (a
  // rare failed send is preferable to a duplicate one from a retry).
  await supabase
    .from("inbound_email_log")
    .update({ receipt_ack_sent: true })
    .eq("id", inboundEmailLogId);

  await sendInvoiceReceiptEmail({
    to: logRow.from_address,
    organizationId: logRow.organization_id,
    orgName: org?.name ?? "the team",
    invoiceCount: invoiceIds.length,
  }).catch((err) => console.error("sendInvoiceReceiptEmail failed:", err));
}

export async function runNextIngestJob(
  supabase: Supabase,
  organizationId: string
): Promise<ProcessResult> {
  // Recover jobs a killed function left stuck mid-flight BEFORE the
  // email-log reset below, so its "is there still something active"
  // check reflects the up-to-date job statuses.
  try {
    await resetStaleIngestJobs(supabase, organizationId);
  } catch (err) {
    console.error("stale-job reset failed:", err);
  }

  // Reset email rows stuck in "processing" (every attachment's job failed
  // or is otherwise no longer active) so they don't show as Processing
  // forever — EXCEPT rows that still have a queued/processing job actively
  // working through them.
  try {
    const { data: activeJobRows } = await supabase
      .from("ingest_jobs")
      .select("inbound_email_log_id")
      .eq("organization_id", organizationId)
      .in("status", ["queued", "processing"]);
    const activeEmailIds = new Set(
      (activeJobRows ?? [])
        .map((j) => j.inbound_email_log_id)
        .filter((id): id is string => !!id)
    );
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    let query = supabase
      .from("inbound_email_log")
      .update({
        processing: false,
        processed: false,
        error: "Processing timed out — please re-forward the email.",
      })
      .eq("organization_id", organizationId)
      .eq("processing", true)
      .lt("created_at", staleCutoff);
    if (activeEmailIds.size > 0) {
      query = query.not("id", "in", [...activeEmailIds]);
    }
    await query;
  } catch (err) {
    console.error("stale-processing reset failed:", err);
  }

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
    // Only reflect the failure in the display tables once it's TERMINAL —
    // a retryable attempt (this one will auto-retry, ingest_jobs.status
    // stays "queued") must not flash the Queue to "Failed" for something
    // that's about to succeed on its own; that was confusingly showing up
    // as a false "failed" during a transient extraction/insert hiccup that
    // the next attempt (seconds later) recovered from cleanly.
    if (terminal) {
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
        const stillActive = await otherActiveJobsExist(supabase, job.inbound_email_log_id, job.id);
        await supabase
          .from("inbound_email_log")
          .update({
            processing: stillActive,
            error: message,
          })
          .eq("id", job.inbound_email_log_id);
        // This job failed for some OTHER reason (not "no invoice data"),
        // but it may still be the last of this email's attachments to
        // settle — a sibling attachment could already be sitting on a
        // NO_INVOICE_DATA_ERROR waiting to be folded in.
        if (!stillActive) {
          await foldBackupDocsIntoSoleInvoice(supabase, job.inbound_email_log_id).catch((err) =>
            console.error("foldBackupDocsIntoSoleInvoice failed:", err)
          );
          await sendReceiptAcknowledgment(supabase, job.inbound_email_log_id).catch((err) =>
            console.error("sendReceiptAcknowledgment failed:", err)
          );
        }
      }
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
      forceSplit: job.force_split ?? false,
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
            error: null,
          })
          .eq("id", job.upload_log_id);
      } else {
        await supabase
          .from("upload_log")
          .update({
            status: "done",
            invoice_id: result.invoice.id,
            processed_at: processedAt,
            error: null,
          })
          .eq("id", job.upload_log_id);
      }
    }

    if (job.inbound_email_log_id) {
      // Append (every attachment on an email gets its own job now, all
      // sharing one email log row) — only clear "processing" once THIS is
      // the last outstanding job for the email (see otherActiveJobsExist).
      const [{ data: logRow }, stillActive] = await Promise.all([
        supabase
          .from("inbound_email_log")
          .select("invoice_ids, pending_split_ids")
          .eq("id", job.inbound_email_log_id)
          .maybeSingle(),
        otherActiveJobsExist(supabase, job.inbound_email_log_id, job.id),
      ]);
      const existingInv = (logRow?.invoice_ids ?? []) as string[];
      const existingSplit = (logRow?.pending_split_ids ?? []) as string[];
      const patch: Partial<
        Database["public"]["Tables"]["inbound_email_log"]["Row"]
      > = {
        processing: stillActive,
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
      if (!stillActive) {
        await foldBackupDocsIntoSoleInvoice(supabase, job.inbound_email_log_id).catch((err) =>
          console.error("foldBackupDocsIntoSoleInvoice failed:", err)
        );
        await sendReceiptAcknowledgment(supabase, job.inbound_email_log_id).catch((err) =>
          console.error("sendReceiptAcknowledgment failed:", err)
        );
      }
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
        const [{ data: logRow }, stillActive] = await Promise.all([
          supabase
            .from("inbound_email_log")
            .select("invoice_ids, pending_split_ids")
            .eq("id", job.inbound_email_log_id)
            .maybeSingle(),
          otherActiveJobsExist(supabase, job.inbound_email_log_id, job.id),
        ]);
        // Don't clobber processed:true if a SIBLING attachment on this
        // same email already succeeded — this one not being an invoice
        // doesn't undo that.
        const hasResults =
          ((logRow?.invoice_ids as string[] | null)?.length ?? 0) > 0 ||
          ((logRow?.pending_split_ids as string[] | null)?.length ?? 0) > 0;
        await supabase
          .from("inbound_email_log")
          .update({ processing: stillActive, processed: hasResults, error: message })
          .eq("id", job.inbound_email_log_id);
        if (!stillActive && hasResults) {
          await foldBackupDocsIntoSoleInvoice(supabase, job.inbound_email_log_id).catch((err) =>
            console.error("foldBackupDocsIntoSoleInvoice failed:", err)
          );
          await sendReceiptAcknowledgment(supabase, job.inbound_email_log_id).catch((err) =>
            console.error("sendReceiptAcknowledgment failed:", err)
          );
        }
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
