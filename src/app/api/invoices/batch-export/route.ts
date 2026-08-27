// Vercel Hobby caps configurable duration at 60s — merging many invoices
// can take a while.
export const maxDuration = 60;

import { createClient } from "@/lib/supabase/server";
import { buildMergedInvoicePdf } from "@/lib/invoice-export";

// Download ALL selected invoices' documents merged into ONE PDF
// (GET /api/invoices/batch-export?ids=a,b,c). Authenticated; RLS scopes the
// downloads to the caller's org. Used by the multi-select "Export PDFs"
// action in the invoice list. Authored by Araza.
export async function GET(request: Request) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const raw = url.searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return new Response("No invoices selected", { status: 400 });

  const pdf = await buildMergedInvoicePdf(supabase, ids);
  if (!pdf) return new Response("Could not build the PDF", { status: 404 });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.pdf"`,
    },
  });
}
