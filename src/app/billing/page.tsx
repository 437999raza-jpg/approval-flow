import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { saveUsageRate } from "@/lib/dashboard-actions";
import { SubmitButton } from "@/components/SubmitButton";

// Flow's usage billing: how many documents this client org has processed,
// at the org's per-document rate (USD) — the charge the client sees. This
// is tracking only: the invoice is sent manually (no payment processor).
// Any org member can view; only admins can change the rate. Authored by
// Araza.

export default async function BillingPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");
  const isAdmin = org.role === "admin";

  const [{ data: events }, { data: orgRow }] = await Promise.all([
    supabase
      .from("usage_events")
      .select("document_name, source, created_at")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("organizations")
      .select("usage_rate_usd")
      .eq("id", org.id)
      .single(),
  ]);
  const rate = orgRow?.usage_rate_usd ?? 0.15;

  // Monthly rollup from the (already capped at 500) most recent events.
  const monthKey = (iso: string) => iso.slice(0, 7); // YYYY-MM
  const byMonth = new Map<string, number>();
  for (const e of events ?? []) {
    const k = monthKey(e.created_at);
    byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
  }
  const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  const totalCount = (events ?? []).length;
  const totalCharge = totalCount * rate;

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link
        href="/dashboard"
        className="text-sm text-slate-500 hover:underline"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Billing & usage</h1>
      <p className="mt-1 text-sm text-slate-500">
        Documents processed for {org.name} at {rate.toFixed(2)} USD each —
        usage tracking only; the invoice is sent manually.
      </p>

      {isAdmin && (
        <form
          action={async (formData: FormData) => {
            await saveUsageRate(formData);
          }}
          className="mt-4 flex max-w-sm items-end gap-2 rounded-md border border-slate-200 p-4"
        >
          <div className="flex-1">
            <label
              htmlFor="usage_rate_usd"
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Rate per document (USD)
            </label>
            <input
              id="usage_rate_usd"
              name="usage_rate_usd"
              type="number"
              step="0.01"
              min="0.01"
              defaultValue={rate}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <SubmitButton className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Save rate
          </SubmitButton>
        </form>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="rounded-md border border-slate-200 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Documents processed
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">
            {totalCount.toLocaleString()}
          </div>
        </div>
        <div className="rounded-md border border-slate-200 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Suggested charge
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">
            {totalCharge.toLocaleString(undefined, {
              style: "currency",
              currency: "USD",
            })}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          By month
        </div>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
              <th className="py-1.5 font-medium">Month</th>
              <th className="py-1.5 text-right font-medium">Documents</th>
              <th className="py-1.5 text-right font-medium">Charge</th>
            </tr>
          </thead>
          <tbody>
            {months.map(([month, count]) => (
              <tr key={month} className="border-b border-slate-100">
                <td className="py-1.5">{month}</td>
                <td className="py-1.5 text-right tabular-nums">{count}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {(count * rate).toLocaleString(undefined, {
                    style: "currency",
                    currency: "USD",
                  })}
                </td>
              </tr>
            ))}
            {months.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-center text-slate-400">
                  No documents processed yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Recent documents
        </div>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {(events ?? []).slice(0, 50).map((e, i) => (
            <li key={i} className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="min-w-0 truncate" title={e.document_name}>
                {e.document_name}
              </span>
              <span className="flex-none text-xs text-slate-400">
                {e.source === "email" ? "email" : "upload"} ·{" "}
                {new Date(e.created_at).toLocaleString()}
              </span>
            </li>
          ))}
          {(events ?? []).length === 0 && (
            <li className="py-4 text-center text-slate-400">
              Nothing yet.
            </li>
          )}
        </ul>
      </div>
    </main>
  );
}
