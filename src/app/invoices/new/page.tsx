import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { InvoiceUploadDropzone } from "@/components/InvoiceUploadDropzone";
import { ExtractionPoller } from "@/components/ExtractionPoller";
import { LocalTime } from "@/components/LocalTime";

export default async function NewInvoicePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  // Auditors are read-only everywhere — the upload API/RLS already reject
  // this, but redirect before they even see the form.
  if (org?.role === "auditor") redirect("/dashboard");

  // Recent uploads from the DB (migration 0054) — the durable record of
  // every upload's outcome. Only the last 20 are shown so the page stays
  // uncluttered; the table keeps more for reporting, and old rows are
  // cleaned up automatically.
  const { data: recentUploads } = org
    ? await supabase
        .from("upload_log")
        .select(
          "id, filename, status, invoice_id, pending_split_id, error, created_at"
        )
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false })
        .limit(20)
    : { data: [] };

  const invoiceIds = [
    ...new Set((recentUploads ?? []).map((u) => u.invoice_id).filter(Boolean)),
  ] as string[];
  const { data: invoices } =
    invoiceIds.length > 0
      ? await supabase
          .from("invoices")
          .select("id, vendor_name, invoice_number")
          .in("id", invoiceIds)
      : { data: [] };
  const invoiceById = new Map((invoices ?? []).map((i) => [i.id, i]));

  return (
    <main className="mx-auto max-w-2xl p-8">
      <ExtractionPoller />
      <Link href="/dashboard" className="text-sm text-slate-500 hover:underline">
        ← Back to dashboard
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Add invoice</h1>
      <p className="mt-1 text-sm text-slate-500">
        Drop one or more invoices — each appears in the queue below as it&apos;s
        processed, then lands as a new invoice in &quot;Pending Review&quot; and enters
        the default approval workflow.
      </p>
      <div className="mt-6">
        <InvoiceUploadDropzone />
      </div>

      {recentUploads && recentUploads.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-slate-700">
            Recent uploads
          </h2>
          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {recentUploads.map((u) => (
              <li key={u.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <LocalTime iso={u.created_at} className="text-xs text-slate-400" />
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {u.filename}
                  </span>
                  {u.status === "done" && (
                    <>
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        Processed
                      </span>
                      {u.invoice_id && (
                        <Link
                          href={`/dashboard/${u.invoice_id}`}
                          className="text-xs font-medium text-blue-600 hover:underline"
                        >
                          {invoiceById.get(u.invoice_id)
                            ? `${invoiceById.get(u.invoice_id)?.vendor_name} · #${invoiceById.get(u.invoice_id)?.invoice_number} →`
                            : "Open →"}
                        </Link>
                      )}
                    </>
                  )}
                  {(u.status === "queued" || u.status === "processing") && (
                    <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                      Processing…
                    </span>
                  )}
                  {u.status === "split" && (
                    <>
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                        Split review
                      </span>
                      <Link
                        href="/invoices/pending-splits"
                        className="text-xs font-medium text-blue-600 hover:underline"
                      >
                        Review →
                      </Link>
                    </>
                  )}
                  {u.status === "error" && (
                    <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                      Rejected
                    </span>
                  )}
                </div>
                {u.status === "error" && u.error && (
                  <p className="mt-1 text-xs text-rose-600">{u.error}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
