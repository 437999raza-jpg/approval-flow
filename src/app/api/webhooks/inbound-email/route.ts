// Vercel Hobby caps configurable duration at 60s — the
// OpenRouter extraction call can take 20-60s.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { InvoiceIngestError } from "@/lib/invoices";
import { ingestInvoiceFile } from "@/lib/invoice-ingest";
import { mergeDocuments } from "@/lib/merge-documents";
import { enqueueIngestJob } from "@/lib/ingest-queue";
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
// Attachments are processed INLINE here (no browser needed — emails never
// wait for the app's poller). How they're interpreted follows a subject
// code the office stamps at the start of the subject:
//   [N1]  → all attachments = ONE invoice (combine, e.g. invoice + backup +
//          certificate)
//   [1M]  → one PDF contains multiple invoices (force split review)
//   [NM]  → every PDF contains multiple invoices (each goes to split review)
//   none  → each PDF is its own invoice (industry default — never merge)
// Persistent failures fall back to the ingest_jobs queue so they auto-retry
// and stay Reprocessable from the Queue page.
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

    // Download every PDF/image attachment first.
    const documents: { name: string; type: string; bytes: Uint8Array }[] = [];
    for (const attachment of attachments) {
      const filename = attachment.filename ?? "attachment";
      const contentType = attachment.content_type ?? "";
      if (!isPdfOrImage(filename, contentType) || !attachment.download_url) {
        continue;
      }
      const dl = await fetch(attachment.download_url);
      if (!dl.ok) {
        errors.push(`Could not download attachment "${filename}"`);
        continue;
      }
      documents.push({
        name: filename,
        type: contentType || "application/octet-stream",
        bytes: new Uint8Array(await dl.arrayBuffer()),
      });
    }

    // Subject code convention (office stamps it when forwarding):
    //   [N1]  → all attachments = ONE invoice (combine)
    //   [1M]  → one PDF contains multiple invoices (force split review)
    //   [NM]  → every PDF contains multiple invoices (each goes to split)
    //   none  → each PDF is its OWN invoice (industry default — never merge)
    // The code only decides; the attachments are always processed inline.
    const code = parseSubjectCode(subject);
    if (code && code.count !== documents.length) {
      console.error(
        `Subject code said [${code.count}${code.kind === "merge" ? "1" : "M"}] but ${documents.length} attachment(s) arrived.`
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
    // in flight), then process inline — an email should never wait for a
    // browser to be open.
    const { data: logRow, error: logInsertError } = await supabase
      .from("inbound_email_log")
      .insert({
        organization_id: org.id,
        from_address: from,
        to_address: candidates.join(", "),
        subject,
        attachment_count: ingestList.length,
        processing: true,
        error: errors.length > 0 ? errors.join("; ") : null,
      })
      .select("id")
      .single();
    if (logInsertError) {
      console.error("inbound_email_log insert failed:", logInsertError);
      return NextResponse.json({ ok: true, errors: ["Could not log the email."] });
    }

    // Emails are processed INLINE right here — the 20–60s wait for THIS
    // email is fine; only persistent failures fall back to the ingest_jobs
    // queue so they auto-retry / stay Reprocessable.
    const invoiceIds: string[] = [];
    const pendingSplitIds: string[] = [];
    const ingestErrors: string[] = [];
    let retryJobQueued = false;

    for (const doc of ingestList) {
      const file = new File([new Uint8Array(doc.bytes)], doc.name, {
        type: doc.type || "application/octet-stream",
      });
      try {
        // One inline retry for transient extraction failures before giving
        // up to the queue.
        let result;
        try {
          result = await ingestInvoiceFile({
            supabase,
            organizationId: org.id,
            file,
            source: "email",
            sourceEmail: from,
            extraContext: subject,
            forceSplit: forceSplitEach,
          });
        } catch {
          result = await ingestInvoiceFile({
            supabase,
            organizationId: org.id,
            file,
            source: "email",
            sourceEmail: from,
            extraContext: subject,
            forceSplit: forceSplitEach,
          });
        }
        if (result.kind === "pending_split") {
          pendingSplitIds.push(result.pendingSplitId);
        } else {
          invoiceIds.push(result.invoice.id);
        }
      } catch (err) {
        const message =
          err instanceof InvoiceIngestError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Unknown ingest error";
        ingestErrors.push(message);
        // Queue a retry job (staging kept) so the poller can retry and the
        // Queue's Reprocess button works — no re-forwarding needed.
        const jobId = await enqueueIngestJob({
          supabase,
          organizationId: org.id,
          file: { name: doc.name, type: doc.type, size: doc.bytes.length, bytes: doc.bytes },
          source: "email",
          sourceEmail: from,
          inboundEmailLogId: logRow.id,
        });
        if (jobId) retryJobQueued = true;
      }
    }

    await supabase
      .from("inbound_email_log")
      .update({
        // Stays "processing" when a retry job is queued — the worker
        // completes the row with the outcome; otherwise settle it now.
        processing: retryJobQueued,
        invoice_ids: invoiceIds,
        pending_split_ids: pendingSplitIds,
        processed: invoiceIds.length > 0 || pendingSplitIds.length > 0,
        error:
          retryJobQueued && invoiceIds.length === 0
            ? null
            : ingestErrors.length > 0
              ? ingestErrors.join("; ")
              : null,
      })
      .eq("id", logRow.id);

    if (invoiceIds.length > 0 || pendingSplitIds.length > 0) {
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

// Subject-code convention (office stamps it at the START of the subject):
//   [N1]  → all attachments = ONE invoice (combine)
//   [1M]  → one PDF contains multiple invoices (force split review)
//   [NM]  → every PDF contains multiple invoices (each goes to split)
// No code → each PDF is its own invoice.
function parseSubjectCode(
  subject: string
): { kind: "merge" | "split"; count: number } | null {
  const m = subject.match(/^\s*\[(\d+)(M|1)\]\s*/i);
  if (!m) return null;
  return {
    kind: m[2].toUpperCase() === "M" ? "split" : "merge",
    count: Number(m[1]),
  };
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
