import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { saveUsageRate, createUsageCheckout } from "@/lib/dashboard-actions";
import { UsageRateForm } from "@/components/UsageRateForm";
import { StripeCheckoutButton } from "@/components/StripeCheckoutButton";

// Flow's usage billing: how many documents this client org has processed,
// at the org's per-document rate (USD) — the charge the client sees. The
// rate is editable (admin only) with a greyed-until-changed Save button and
// its saved-on date. Stripe Checkout ("Pay now") charges the suggested
// amount via Stripe's hosted page when configured. Authored by Araza.

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { payment?: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");
  const isAdmin = org.role === "admin";
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY);

  const [{ data: events }, { data: orgRow }] = await Promise.all([
    supabase
      .from("usage_events")
      .select("document_name, source, created_at")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("organizations")
      .select("usage_rate_usd, usage_rate_updated_at")
      .eq("id", org.id)
      .single(),
  ]);
  const rate = orgRow?.usage_rate_usd ?? 0.15;
  const savedAt = orgRow?.usage_rate_updated_at ?? null;

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
  const canPay = totalCount > 0 && stripeConfigured;

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link
        href="/dashboard"
        className="text-sm text-slate-500 hover:underline"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Billing &amp; usage</h1>
      <p className="mt-1 text-sm text-slate-500">
        Documents processed for {org.name} at {rate.toFixed(2)} USD each.
      </p>

      {searchParams.payment === "success" && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Payment complete — thank you!
        </div>
      )}
      {searchParams.payment === "cancelled" && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Payment cancelled — nothing was charged.
        </div>
      )}

      {/* Rate per document */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Rate per document
        </div>
        {isAdmin ? (
          <UsageRateForm
            currentRate={rate}
            savedAt={savedAt}
            action={saveUsageRate}
          />
        ) : (
          <div className="mt-2 text-sm text-slate-700">
            {rate.toFixed(2)} USD
            {savedAt
              ? ` — saved on ${new Date(savedAt).toLocaleDateString()}`
              : ""}
          </div>
        )}
      </section>

      {/* Summary */}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Documents processed
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">
            {totalCount.toLocaleString()}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
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

      {/* Payment */}
      <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Payment
        </div>
        {canPay ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              Pay the suggested charge of{" "}
              <strong>
                {totalCharge.toLocaleString(undefined, {
                  style: "currency",
                  currency: "USD",
                })}
              </strong>{" "}
              ({totalCount} document{totalCount === 1 ? "" : "s"} ×{" "}
              {rate.toFixed(2)}). You&apos;ll be taken to Stripe&apos;s secure
              checkout page.
            </p>
            <StripeCheckoutButton action={createUsageCheckout} />
          </>
        ) : stripeConfigured ? (
          <p className="mt-1 text-sm text-slate-500">
            No usage to bill yet — documents processed will appear here.
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-500">
            Stripe is not configured yet. Set{" "}
            <code className="rounded bg-slate-100 px-1">STRIPE_SECRET_KEY</code>{" "}
            to enable payments.
          </p>
        )}
      </section>

      {/* By month */}
      <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
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
      </section>

      {/* Recent documents */}
      <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Recent documents
        </div>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {(events ?? []).slice(0, 50).map((e, i) => (
            <li
              key={i}
              className="flex items-baseline justify-between gap-4 py-1.5"
            >
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
            <li className="py-4 text-center text-slate-400">Nothing yet.</li>
          )}
        </ul>
      </section>
    </main>
  );
}
