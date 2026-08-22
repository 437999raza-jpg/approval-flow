import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { normalizeForMatching } from "@/lib/matching";
import { saveSupplierDefaults, saveSupplierIntegration } from "@/lib/dashboard-actions";
import { SearchInput } from "@/components/SearchInput";
import { SupplierSettingsRow, type SupplierSettingsRowValues } from "@/components/SupplierSettingsRow";

// Suppliers are one-way from QBO: Flow never creates them there, so there
// is nothing to "add" here — this page only lets you set defaults on
// suppliers that already exist (synced via Settings -> Data from
// QuickBooks -> "Sync suppliers"). A new supplier created in QBO shows up
// here after the next sync, ready to configure.
const PAGE_SIZE = 200;

export default async function SuppliersSettingsPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/settings");

  const readOnly = org.role === "auditor";
  const q = searchParams.q?.trim() ?? "";

  const [
    suppliersRes,
    { data: qboCategoryRows },
    { data: qboClassRows },
    { data: qboTaxCodeRows },
  ] = await Promise.all([
    (() => {
      let query = supabase
        .from("qbo_suppliers")
        .select("id, qbo_vendor_id, name, name_normalized, integration", { count: "exact" })
        .eq("organization_id", org.id)
        .eq("active", true)
        .order("name", { ascending: true })
        .range(0, PAGE_SIZE - 1);
      if (q) query = query.ilike("name", `%${q}%`);
      return query;
    })(),
    supabase
      .from("qbo_categories")
      .select("name, acct_num")
      .eq("organization_id", org.id)
      .eq("active", true)
      .order("name", { ascending: true })
      .limit(1000),
    supabase
      .from("qbo_classes")
      .select("name")
      .eq("organization_id", org.id)
      .eq("active", true)
      .order("name", { ascending: true })
      .limit(1000),
    supabase
      .from("qbo_tax_codes")
      .select("name, rate_value")
      .eq("organization_id", org.id)
      .not("rate_value", "is", null)
      .order("name", { ascending: true }),
  ]);

  const suppliers = suppliersRes.data ?? [];
  const totalSuppliers = suppliersRes.count ?? suppliers.length;

  const normalizedNames = suppliers.map((s) => s.name_normalized);

  // supplier_defaults rows for exactly the suppliers on this page.
  const { data: defaultsRows } =
    normalizedNames.length > 0
      ? await supabase
          .from("supplier_defaults")
          .select(
            "vendor_name_normalized, category, class, product_service, tax_rate, currency, payment_terms_days"
          )
          .eq("organization_id", org.id)
          .in("vendor_name_normalized", normalizedNames)
      : { data: [] };
  const defaultsByNormalizedName = new Map(
    (defaultsRows ?? []).map((d) => [d.vendor_name_normalized, d])
  );

  // "Items" = invoices Flow has processed from this supplier. Paged
  // across the WHOLE org (not just this page of suppliers) since it's a
  // single cheap query either way and every supplier needs a count.
  const itemCountByNormalizedName = new Map<string, number>();
  {
    let from = 0;
    const chunk = 1000;
    for (;;) {
      const { data, error } = await supabase
        .from("invoices")
        .select("vendor_name")
        .eq("organization_id", org.id)
        .range(from, from + chunk - 1);
      if (error || !data) break;
      for (const row of data) {
        const key = normalizeForMatching(row.vendor_name);
        if (key) itemCountByNormalizedName.set(key, (itemCountByNormalizedName.get(key) ?? 0) + 1);
      }
      if (data.length < chunk) break;
      from += chunk;
    }
  }

  const qboCategoryNames: string[] = [
    ...new Set(
      (qboCategoryRows ?? []).map((c) => (c.acct_num ? `${c.acct_num} - ${c.name}` : c.name))
    ),
  ].sort((a, b) => a.localeCompare(b));
  const qboClassNames: string[] = [
    ...new Set((qboClassRows ?? []).map((c) => c.name)),
  ].sort((a, b) => a.localeCompare(b));
  const qboTaxRateOptions: { value: string; label: string }[] = (qboTaxCodeRows ?? [])
    .filter((c) => c.rate_value != null)
    .map((c) => ({ value: String(c.rate_value), label: `${c.name} (${c.rate_value}%)` }));

  const rows: SupplierSettingsRowValues[] = suppliers.map((s) => {
    const d = defaultsByNormalizedName.get(s.name_normalized);
    return {
      qboSupplierId: s.id,
      name: s.name,
      itemCount: itemCountByNormalizedName.get(s.name_normalized) ?? 0,
      integration: s.integration,
      category: d?.category ?? "",
      productService: d?.product_service ?? "",
      class: d?.class ?? "",
      taxRate: d?.tax_rate != null ? String(d.tax_rate) : "",
      currency: d?.currency ?? "",
      paymentTermsDays: d?.payment_terms_days != null ? String(d.payment_terms_days) : "",
    };
  });

  return (
    <main className="mx-auto max-w-7xl p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/settings" className="text-sm text-blue-600 hover:underline">
            ← Settings
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">Suppliers</h1>
          <p className="mt-1 text-sm text-slate-500">
            Read-only from QuickBooks — Flow never creates suppliers. Set
            defaults here once and every future invoice from that supplier
            picks them up automatically. The same defaults are shown in
            each bill&apos;s &quot;Supplier rules&quot; — edit either place,
            both stay in sync.
          </p>
        </div>
        <div className="w-72 flex-none">
          <SearchInput defaultValue={q} placeholder="Filter by name…" />
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[1100px] border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <th className="px-2 py-2.5">Name</th>
              <th className="px-2 py-2.5 text-center">Items</th>
              <th className="px-2 py-2.5">Integration</th>
              <th className="px-2 py-2.5">Category</th>
              <th className="px-2 py-2.5">Product/Service</th>
              <th className="px-2 py-2.5">Class</th>
              <th className="px-2 py-2.5">Tax rate</th>
              <th className="px-2 py-2.5">Currency</th>
              <th className="px-2 py-2.5">Terms (days)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <SupplierSettingsRow
                key={s.qboSupplierId}
                supplier={s}
                qboCategories={qboCategoryNames}
                qboClasses={qboClassNames}
                qboTaxRates={qboTaxRateOptions}
                readOnly={readOnly}
                saveDefaults={saveSupplierDefaults.bind(null, null)}
                saveIntegration={saveSupplierIntegration}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-400">
                  {q
                    ? `No suppliers match "${q}".`
                    : "No suppliers synced yet — run \"Sync suppliers from QuickBooks\" in Settings."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalSuppliers > rows.length && (
        <p className="mt-3 text-xs text-slate-400">
          Showing {rows.length} of {totalSuppliers} suppliers
          {q ? ` matching "${q}"` : ""} — narrow the search above to find more.
        </p>
      )}
    </main>
  );
}
