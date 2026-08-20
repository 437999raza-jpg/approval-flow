import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createInvoiceFromFile, InvoiceIngestError } from "@/lib/invoices";

// Inbound email path: point a SendGrid "Inbound Parse" route at
// https://yourapp.com/api/webhooks/inbound-email?token=INBOUND_EMAIL_WEBHOOK_SECRET
// for the subdomain in INBOUND_EMAIL_DOMAIN. SendGrid POSTs each email as
// multipart/form-data with `to`, `from`, `subject`, `attachments` (count),
// and `attachment1..N` file fields. See README for full setup.
//
// Each org has a unique inbound_email_token; mail sent to
// {token}@{INBOUND_EMAIL_DOMAIN} is attributed to that org.
export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== process.env.INBOUND_EMAIL_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const formData = await request.formData();

  const to = String(formData.get("to") ?? "");
  const from = String(formData.get("from") ?? "");
  const subject = String(formData.get("subject") ?? "");

  const localPart = to.split("@")[0]?.trim().toLowerCase();
  const { data: org } = localPart
    ? await supabase
        .from("organizations")
        .select("id")
        .eq("inbound_email_token", localPart)
        .maybeSingle()
    : { data: null };

  if (!org) {
    await supabase.from("inbound_email_log").insert({
      from_address: from,
      to_address: to,
      subject,
      processed: false,
      error: `No organization found for inbound address "${to}"`,
    });
    // Return 200 so the email provider doesn't retry-storm an address that
    // will never resolve.
    return NextResponse.json({ ok: true, matched: false });
  }

  const attachmentCount = Number(formData.get("attachments") ?? 0);
  const invoiceIds: string[] = [];
  const errors: string[] = [];

  for (let i = 1; i <= attachmentCount; i++) {
    const file = formData.get(`attachment${i}`);
    if (!(file instanceof File)) continue;

    try {
      const invoice = await createInvoiceFromFile({
        supabase,
        organizationId: org.id,
        file,
        source: "email",
        sourceEmail: from,
      });
      invoiceIds.push(invoice.id);
    } catch (err) {
      errors.push(
        err instanceof InvoiceIngestError ? err.message : "Unknown ingest error"
      );
    }
  }

  await supabase.from("inbound_email_log").insert({
    organization_id: org.id,
    from_address: from,
    to_address: to,
    subject,
    attachment_count: attachmentCount,
    invoice_ids: invoiceIds,
    processed: invoiceIds.length > 0,
    error: errors.length > 0 ? errors.join("; ") : null,
  });

  return NextResponse.json({ ok: true, invoiceIds, errors });
}
