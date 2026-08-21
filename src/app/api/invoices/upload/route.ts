import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { InvoiceIngestError } from "@/lib/invoices";
import { ingestInvoiceFile } from "@/lib/invoice-ingest";

// Manual upload path: signed-in user clicks "Add invoice" / drags a file in.
// A multi-page PDF classified as several separate invoices doesn't create
// anything yet — it lands in pending_invoice_splits for review instead.
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

  try {
    const result = await ingestInvoiceFile({
      supabase,
      organizationId: org.id,
      file,
      source: "manual",
      submittedBy: user.id,
    });
    if (result.kind === "pending_split") {
      return NextResponse.json(
        { pendingSplitId: result.pendingSplitId, groupCount: result.groupCount },
        { status: 202 }
      );
    }
    return NextResponse.json({ invoice: result.invoice }, { status: 201 });
  } catch (err) {
    if (err instanceof InvoiceIngestError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
