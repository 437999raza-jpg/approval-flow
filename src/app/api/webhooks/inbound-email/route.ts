// Vercel Hobby caps configurable duration at 60s — the
// OpenRouter extraction call can take 20-60s.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { mergeDocuments, imageDimensions } from "@/lib/merge-documents";
import { recordUsageEvent } from "@/lib/usage";
import { enqueueIngestJob, runNextIngestJob } from "@/lib/ingest-queue";
import { INVOICES_TAG } from "@/lib/org-cache";

// Inbound email path (Resend — the same vendor as outbound notifications):
//
// 1. Add the receiving domain (e.g. flow.ufirst.co) to Resend
//    (Domains → Add domain → enable Receiving) and add the MX + verification
//    records it shows at your DNS provider.
// 2. Resend → Domains → {domain} → Receiving → set the webhook URL to
//    https://yourapp.com/api/webhooks/inbound-email?token=INBOUND_EMAIL_WEBHOOK_SECRET
// 3. Resend POSTs a JSON `email.received` event (metadata only — no bodies or
//    attachments). We then pull the attachments via the Resend API using the
//    `email_id` and download each one from its signed URL.
//
// Each org has a unique inbound_email_token and (optionally) a friendly
// inbound_email_local (migration 0051); mail sent to
// {local or token}@{INBOUND_EMAIL_DOMAIN} is attributed to that org — the
// ApprovalMax/Dext model: the address lives on OUR domain, clients change
// nothing.
//
// When an email carries several PDF/image attachments (an invoice plus a
// backup/certificate, say), how they're interpreted follows a subject code
// the office stamps at the START of the subject — PDF count FIRST, invoice
// count SECOND:
//   [X1]  → X PDFs = ONE invoice (combine, e.g. [31] invoice + backup +
//          certificate)
//   [1N]  → one PDF contains N invoices (force split review, e.g. [13])
//   [NN]  → N PDFs = N invoices (each its own — same as no code, e.g. [22])
//   [NM]  → every PDF contains multiple invoices (each goes to split review)
//   none  → each PDF is its own invoice (industry default — never merge)
//
// Every resulting attachment becomes a durable ingest_jobs row BEFORE any
// extraction runs (not just the ones that overflow this request's time
// budget or error) — this request then works through as many of them as
// it can (reusing runNextIngestJob, the same code the background poller
// calls) so an email still doesn't need a browser open to finish, but a
// hard timeout mid-attachment only ever risks the ONE job in flight
// (resetStaleIngestJobs recovers it automatically) instead of losing
// whatever hadn't been reached yet with no record it existed.
export async function POST(request: Request) {
  const url = new URL(request.url);
  if (
    url.searchParams.get("token") !== process.env.INBOUND_EMAIL_WEBHOOK_SECRET
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: {
    type?: string;
    data?: {
      email_id?: string;
      from?: string;
      to?: string[];
      received_for?: string[];
      subject?: string;
    };
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // Ignore non-received events (sent/bounced/delivered etc.).
  if (payload.type !== "email.received" || !payload.data?.email_id) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const supabase = createAdminClient();
  const { email_id, from = "", subject = "" } = payload.data;

  // The recipient(s) — check the envelope `to` plus `received_for` (the
  // addresses an email was forwarded for). Either can carry our address.
  const candidates = [
    ...(payload.data.to ?? []),
    ...(payload.data.received_for ?? []),
  ]
    .map((a) => String(a).trim().toLowerCase())
    .filter(Boolean);

  const org = await resolveOrgByAddress(supabase, candidates);
  if (!org) {
    await supabase.from("inbound_email_log").insert({
      from_address: from,
      to_address: candidates.join(", "),
      subject,
      processed: false,
      error: `No organization found for inbound address "${candidates.join(", ")}"`,
    });
    // Return 200 so the email provider doesn't retry-storm an address that
    // will never resolve.
    return NextResponse.json({ ok: true, matched: false });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    await supabase.from("inbound_email_log").insert({
      organization_id: org.id,
      from_address: from,
      to_address: candidates.join(", "),
      subject,
      processed: false,
      error: "RESEND_API_KEY is not set — cannot fetch attachments.",
    });
    return NextResponse.json({ ok: true, error: "RESEND_API_KEY missing" });
  }

  const errors: string[] = [];

  try {
    // List the email's attachments (metadata + signed download URLs).
    // Resend can still be indexing the email for a moment after the
    // webhook fires, so retry a few times with a short backoff; on final
    // failure include the raw response so the queue log shows what Resend
    // actually said.
    const attachments = await listResendAttachments(apiKey, email_id);

    // Download every PDF/image attachment first, skipping signature/logo
    // images (they are NOT invoices — see isLikelySignatureImage, which
    // only ever applies to images, never PDFs) and recording whatever was
    // dropped (non-PDF files like spreadsheets too) so nothing silently
    // disappears from an email.
    const documents: { name: string; type: string; bytes: Uint8Array }[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const attachment of attachments) {
      const filename = attachment.filename ?? "attachment";
      const contentType = attachment.content_type ?? "";
      if (!isPdfOrImage(filename, contentType) || !attachment.download_url) {
        skipped.push({
          name: filename,
          reason: "not a PDF or image — cannot be processed",
        });
        continue;
      }
      const dl = await fetch(attachment.download_url);
      if (!dl.ok) {
        errors.push(`Could not download attachment "${filename}"`);
        continue;
      }
      const bytes = new Uint8Array(await dl.arrayBuffer());
      // Only IMAGES are ever signature candidates — a PDF is never skipped
      // here (clearance certificates, cover pages etc. still go through
      // extraction, and the no-invoice guard rejects non-invoices).
      const isImage =
        contentType.startsWith("image/") ||
        /\.(png|jpe?g|gif|webp)$/i.test(filename);
      if (isImage && isLikelySignatureImage(filename, bytes)) {
        skipped.push({
          name: filename,
          reason: "looks like a signature or logo image — not an invoice",
        });
        continue;
      }
      documents.push({
        name: filename,
        type: contentType || "application/octet-stream",
        bytes,
      });
    }

    // Usage billing: one event per accepted document (signature images and
    // non-PDF files were already skipped above). Recorded NOW — at
    // acceptance — never at retry time, so a document that fails and gets
    // re-queued still counts exactly once. Best-effort.
    for (const doc of documents) {
      await recordUsageEvent(supabase, org.id, doc.name, "email");
    }

    // Subject code convention (PDF count FIRST, invoice count SECOND).
    // Brackets are REQUIRED — a bare number is never read as a code, so a
    // subject that starts with a real number (invoice #, amount, date)
    // can't be misrouted:
    //   [31] → 3 PDFs, 1 invoice  → combine into one
    //   [13] → 1 PDF, 3 invoices  → force split review
    //   [22] → 2 PDFs, 2 invoices → each PDF its own invoice
    //   [NM] → N PDFs, multiple   → every PDF goes to split review
    //   none → each PDF is its OWN invoice (never merge)
    // The code only decides how the attachments are grouped; each is then
    // queued and processed durably (see the enqueue step below).
    const code = parseSubjectCode(subject);
    if (code && code.x !== documents.length) {
      console.error(
        `Subject code [${code.x}${code.y}] said ${code.x} attachment(s) but ${documents.length} arrived.`
      );
    }

    let ingestList = documents;
    if (code?.kind === "merge" && documents.length > 1) {
      const merged = await mergeDocuments(documents);
      if (merged) {
        const stem = documents[0].name.replace(/\.[^.]+$/, "") || "attachment";
        ingestList = [
          {
            name: `${stem}-merged.pdf`,
            type: "application/pdf",
            bytes: merged,
          },
        ];
      } else {
        errors.push(
          "Could not combine the attachments into one document — ingesting them separately."
        );
      }
    }
    const forceSplitEach = code?.kind === "split";

    // Record the email immediately (processing=true so the Queue shows it
    // in flight). Every attachment is then queued as a durable job and
    // worked through right here in this same request where possible — an
    // email should never wait for a browser to be open — while staying
    // completely safe if it can't all fit in this invocation's budget.
    const { data: logRow, error: logInsertError } = await supabase
      .from("inbound_email_log")
      .insert({
        organization_id: org.id,
        from_address: from,
        to_address: candidates.join(", "),
        subject,
        attachment_count: ingestList.length,
        skipped_attachments: skipped.length > 0 ? skipped : null,
        processing: true,
        error: errors.length > 0 ? errors.join("; ") : null,
      })
      .select("id")
      .single();
    if (logInsertError) {
      console.error("inbound_email_log insert failed:", logInsertError);
      return NextResponse.json({ ok: true, errors: ["Could not log the email."] });
    }

    // Every attachment becomes a durable, individually-tracked job the
    // moment the email arrives — BEFORE any slow extraction starts. This
    // is what makes partial failure safe: if this function gets hard-killed
    // by Vercel's 60s cap mid-way through, only the ONE job actively being
    // worked on is at risk (recovered automatically — see
    // resetStaleIngestJobs in ingest-queue.ts) — everything else already
    // sits safely `queued`, exactly where the poller expects to find it.
    // The old approach processed most attachments inline and only created
    // a job for whatever didn't fit in time or errored, so anything done
    // inline had NO durable record at all — a hard kill lost it completely,
    // with no way to recover except re-forwarding the WHOLE email, which
    // then reprocessed the attachments that had already succeeded too.
    const enqueueErrors: string[] = [];
    for (const doc of ingestList) {
      const jobId = await enqueueIngestJob({
        supabase,
        organizationId: org.id,
        file: { name: doc.name, type: doc.type, size: doc.bytes.length, bytes: doc.bytes },
        source: "email",
        sourceEmail: from,
        inboundEmailLogId: logRow.id,
        forceSplit: forceSplitEach,
      });
      if (!jobId) enqueueErrors.push(`Could not queue "${doc.name}" for processing.`);
    }

    // Work through as much of the queue as fits in this invocation's time
    // budget, reusing the EXACT same claim-and-process logic the
    // background poller uses (runNextIngestJob) — one code path for
    // "process one queued job" instead of two that could drift apart.
    // It also updates upload_log/inbound_email_log/ingest_jobs itself as
    // each job completes, so there's nothing left for this route to do
    // afterward. Whatever doesn't fit in the budget stays queued for the
    // poller (or the next email's own pass through this same loop, for
    // this org) to pick up.
    const INLINE_BUDGET_MS = 35_000; // leave headroom under Vercel's 60s cap
    const startMs = Date.now();
    let ranAny = false;
    for (;;) {
      if (Date.now() - startMs > INLINE_BUDGET_MS) break;
      const result = await runNextIngestJob(supabase, org.id);
      if (!result.ran) break;
      ranAny = true;
      if (result.pending === 0) break;
    }

    if (enqueueErrors.length > 0) {
      const { data: current } = await supabase
        .from("inbound_email_log")
        .select("error")
        .eq("id", logRow.id)
        .maybeSingle();
      const combined = [current?.error, ...enqueueErrors].filter(Boolean).join("; ");
      await supabase.from("inbound_email_log").update({ error: combined }).eq("id", logRow.id);
    }

    if (ranAny) {
      revalidateTag(INVOICES_TAG); // new invoices/splits from email
    }
  } catch (err) {
    errors.push(
      err instanceof Error ? err.message : "Unknown Resend API error"
    );
    if (supabase) {
      await supabase.from("inbound_email_log").insert({
        organization_id: org.id,
        from_address: from,
        to_address: candidates.join(", "),
        subject,
        processed: false,
        error: errors.join("; "),
      });
    }
  }

  // Keep the queue short: drop log/job rows older than 90 days (best-effort).
  await supabase
    .from("inbound_email_log")
    .delete()
    .eq("organization_id", org.id)
    .lt("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .then((r) => r.error && console.error("inbound_email_log cleanup:", r.error));
  // Prune old ingest jobs + their staging files (staging is kept for the
  // Reprocess button until it ages out here).
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: oldJobs } = await supabase
    .from("ingest_jobs")
    .select("staging_path")
    .eq("organization_id", org.id)
    .lt("created_at", cutoff);
  await supabase
    .from("ingest_jobs")
    .delete()
    .eq("organization_id", org.id)
    .lt("created_at", cutoff)
    .then((r) => r.error && console.error("ingest_jobs cleanup:", r.error));
  const stalePaths = (oldJobs ?? []).map((j) => j.staging_path);
  if (stalePaths.length > 0) {
    await supabase.storage
      .from("invoices")
      .remove(stalePaths)
      .then((r) => r.error && console.error("staging cleanup:", r.error));
  }

  return NextResponse.json({ ok: true, queued: true });
}

// Attribute an inbound email to an org. The friendly local part (if set)
// wins over the token; both work, and both are unique per tenant.
async function resolveOrgByAddress(
  supabase: ReturnType<typeof createAdminClient>,
  addresses: string[]
) {
  for (const address of addresses) {
    const localPart = address.split("@")[0]?.trim().toLowerCase();
    if (!localPart) continue;

    const { data: byLocal } = await supabase
      .from("organizations")
      .select("id")
      .eq("inbound_email_local", localPart)
      .maybeSingle();
    if (byLocal) return byLocal;

    const { data: byToken } = await supabase
      .from("organizations")
      .select("id")
      .eq("inbound_email_token", localPart)
      .maybeSingle();
    if (byToken) return byToken;
  }
  return null;
}

function isPdfOrImage(filename: string, contentType: string) {
  const name = filename.toLowerCase();
  return (
    contentType === "application/pdf" ||
    name.endsWith(".pdf") ||
    contentType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/.test(name)
  );
}

// Email signatures and logos are images, but they are NOT invoices, and
// ingesting them creates the blank junk bills seen in the wild (a logo
// extracts a vendor name from the logo text, passes the "not empty" check,
// and becomes a bill with no number/total/lines). Detect the common shapes:
//   - names containing logo/signature/sign/sig,
//   - Outlook-style inline images (image001.jpg, img-<uuid>.png) that are
//     small or tiny,
//   - tiny files, and wide-and-short strips (a signature is ~4:1+).
// Real invoice images are page-shaped (roughly square-ish, larger) and are
// never dropped here. ONLY IMAGES are checked — a PDF is never a
// signature image, no matter how small (a clearance certificate or cover
// page still goes through extraction, and the no-invoice guard catches
// anything that isn't an invoice).
function isLikelySignatureImage(name: string, bytes: Uint8Array): boolean {
  const n = name.toLowerCase();
  const dims = imageDimensions(bytes);
  const size = bytes.length;

  const sigName =
    /(^|[._-])(logo|signature|sign|sig|letterhead)([._-]|$)/.test(n);
  if (sigName) return true;
  if (!dims) return false; // not a decodable image (e.g. a PDF) — never skip

  const { width: w, height: h } = dims;
  const inlineName = /^image\d*\./.test(n) || /^img-/.test(n);
  const tiny = size < 60_000 && (w < 500 || h < 400);
  const strip = size < 150_000 && w / h > 3.5;
  const smallish = size < 120_000 && (w < 500 || h < 400);
  return tiny || strip || (inlineName && smallish);
}

// Subject-code convention (office stamps it at the START of the subject).
// BRACKETS ARE REQUIRED — the code must be "[31]", "[13]", "[NM]", etc.
// A bare "31" is NOT read as a code: subjects frequently start with real
// numbers (invoice numbers like "26-2403", amounts, dates), and treating
// any leading number pair as a code would misroute those emails. Only an
// explicit bracketed code opts into merge/split behaviour. PDF count
// FIRST, invoice count SECOND:
//   [31] → 3 PDFs, 1 invoice  → combine all into one
//   [13] → 1 PDF, 3 invoices  → force split review
//   [22] → 2 PDFs, 2 invoices → each PDF its own invoice (default)
//   [NM] → N PDFs, multiple   → every PDF goes to split review
// No code → each PDF is its own invoice.
function parseSubjectCode(
  subject: string
): { kind: "merge" | "split" | "none"; x: number; y: number | "M" } | null {
  const m = subject.match(/^\s*\[(\d+)(M|\d+)\]\s*/i);
  if (!m) return null;
  const x = Number(m[1]);
  const yRaw = m[2].toUpperCase();
  if (yRaw === "M") return { kind: "split", x, y: "M" };
  const y = Number(yRaw);
  if (y === 1) return { kind: "merge", x, y }; // X1 → combine
  if (x === 1) return { kind: "split", x, y }; // 1N → one PDF, N invoices
  if (y === x) return { kind: "none", x, y }; // NN → default (each its own)
  return { kind: "none", x, y }; // ambiguous (e.g. 32) → default + mismatch log
}

// Resend's attachments list for a received email. The email may still be
// indexing for a moment after the webhook fires, so retry with backoff; on
// final failure include the raw response so the queue log shows what Resend
// actually said.
async function listResendAttachments(apiKey: string, emailId: string) {
  type AttachmentMeta = {
    id?: string;
    filename?: string;
    content_type?: string;
    download_url?: string;
  };
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // NOTE: received-email APIs live under /emails/receiving/ — the plain
    // /emails/{id} path is for SENT emails and returns "Email not found"
    // for received ones.
    const res = await fetch(
      `https://api.resend.com/emails/receiving/${emailId}/attachments`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (res.ok) {
      const json = (await res.json()) as { data?: AttachmentMeta[] };
      return json.data ?? [];
    }
    const body = (await res.text()).slice(0, 300);
    lastErr = `Resend attachments list failed (${res.status}): ${body} (email_id ${emailId})`;
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(lastErr ?? "Resend attachments list failed");
}
