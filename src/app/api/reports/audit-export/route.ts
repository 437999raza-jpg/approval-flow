// Vercel Hobby caps configurable duration at 60s — building an audit PDF
// per invoice, plus merging many invoices' original documents, can take a
// while for a large report.
export const maxDuration = 60;

import { createClient } from "@/lib/supabase/server";
import { buildAuditPlusInvoicesPdf } from "@/lib/invoice-export";

// Download the audit report + original documents for every invoice in a
// report's result set, merged into ONE PDF (GET
// /api/reports/audit-export?ids=a,b,c). Authenticated; RLS scopes it to
// whatever invoices the caller can already see, same as
// /api/invoices/batch-export. Authored by Araza.
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

  const pdf = await buildAuditPlusInvoicesPdf(supabase, ids);
  if (!pdf) return new Response("Could not build the PDF", { status: 404 });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="audit-report-${new Date().toISOString().slice(0, 10)}.pdf"`,
    },
  });
}
