import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { BackToDashboardButton } from "@/components/BackToDashboardButton";

export default async function PendingSplitsListPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");

  const { data: pending } = await supabase
    .from("pending_invoice_splits")
    .select("*")
    .eq("organization_id", org.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto max-w-3xl p-8">
      <BackToDashboardButton />
      <h1 className="mt-2 text-xl font-semibold">Needs split review</h1>
      <p className="mt-1 text-sm text-slate-500">
        Uploads (manual or by email) that looked like they contain more than one invoice.
        Nothing is created until you review and confirm the split.
      </p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {searchParams.error}
        </div>
      )}

      {(pending ?? []).length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">Nothing waiting on review.</p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {(pending ?? []).map((p) => (
            <li key={p.id}>
              <Link
                href={`/invoices/pending-splits/${p.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{p.file_name}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {p.groups.length} invoices detected · {p.page_count} pages · {p.source}
                    {p.source_email ? ` (${p.source_email})` : ""} ·{" "}
                    {new Date(p.created_at).toLocaleString()}
                  </p>
                </div>
                <span className="flex-none rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-medium text-orange-800">
                  Review
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
