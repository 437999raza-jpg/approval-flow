// Vercel Hobby caps configurable duration at 60s — the
// OpenRouter extraction call can take 20-60s.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InvoiceIngestError } from "@/lib/invoices";
import { ingestInvoiceFile } from "@/lib/invoice-ingest";

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

  const invoiceIds: string[] = [];
  const pendingSplitIds: string[] = [];
  const errors: string[] = [];

  try {
    // List the email's attachments (metadata + signed download URLs).
    const listRes = await fetch(
      `https://api.resend.com/emails/${email_id}/attachments`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!listRes.ok) {
      throw new Error(`Resend attachments list failed (${listRes.status})`);
    }
    const listJson = (await listRes.json()) as {
      data?: {
        id?: string;
        filename?: string;
        content_type?: string;
        download_url?: string;
      }[];
    };
    const attachments = listJson.data ?? [];

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
      const bytes = new Uint8Array(await dl.arrayBuffer());
      const file = new File([bytes], filename, {
        type: contentType || "application/octet-stream",
      });

      try {
        const result = await ingestInvoiceFile({
          supabase,
          organizationId: org.id,
          file,
          source: "email",
          sourceEmail: from,
        });
        if (result.kind === "pending_split") {
          pendingSplitIds.push(result.pendingSplitId);
        } else {
          invoiceIds.push(result.invoice.id);
        }
      } catch (err) {
        errors.push(
          err instanceof InvoiceIngestError
            ? err.message
            : `Unknown ingest error for "${filename}"`
        );
      }
    }
  } catch (err) {
    errors.push(
      err instanceof Error ? err.message : "Unknown Resend API error"
    );
  }

  await supabase.from("inbound_email_log").insert({
    organization_id: org.id,
    from_address: from,
    to_address: candidates.join(", "),
    subject,
    attachment_count: invoiceIds.length + pendingSplitIds.length,
    invoice_ids: invoiceIds,
    processed: invoiceIds.length > 0 || pendingSplitIds.length > 0,
    error: errors.length > 0 ? errors.join("; ") : null,
  });

  return NextResponse.json({ ok: true, invoiceIds, pendingSplitIds, errors });
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
