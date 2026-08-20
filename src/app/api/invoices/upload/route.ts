import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { createInvoiceFromFile, InvoiceIngestError } from "@/lib/invoices";

// Manual upload path: signed-in user clicks "Add invoice" / drags a file in.
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

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  try {
    const invoice = await createInvoiceFromFile({
      supabase,
      organizationId: org.id,
      file,
      source: "manual",
      submittedBy: user.id,
    });
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (err) {
    if (err instanceof InvoiceIngestError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
