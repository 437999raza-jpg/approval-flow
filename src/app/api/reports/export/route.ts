import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { buildInvoiceListReport, invoiceListToCsv } from "@/lib/invoice-list-report";
import type { ReportFilters } from "@/lib/reports";

// Download the invoice-list report as CSV (GET /api/reports/export?...
// same filter params as the report builder). Sorted by customer then
// supplier. Authenticated; runs against whatever invoices RLS already
// lets the caller see, so an admin gets the whole org and a "user" gets
// their own scope. Authored by Araza.
export async function GET(request: Request) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const org = await getCurrentOrg(supabase);
  if (!org) return new Response("No organization", { status: 400 });

  const url = new URL(request.url);
  const text = (key: string) => url.searchParams.get(key)?.trim() || undefined;
  const num = (key: string) => {
    const raw = url.searchParams.get(key);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const filters: ReportFilters = {
    status: text("f_status"),
    vendor: text("f_vendor"),
    project_id: text("f_project"),
    amount_over: num("f_amount_over"),
    amount_under: num("f_amount_under"),
    from: text("f_from"),
    to: text("f_to"),
  };

  const rows = await buildInvoiceListReport(supabase, org.id, filters);
  const csv = invoiceListToCsv(rows);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
