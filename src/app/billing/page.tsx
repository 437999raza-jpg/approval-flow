import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { saveUsageRate, createUsageCheckout, createBillingPortalSession } from "@/lib/dashboard-actions";
import { UsageRateForm } from "@/components/UsageRateForm";
import { StripeCheckoutButton } from "@/components/StripeCheckoutButton";

// Flow's usage billing: how many documents this client org has processed,
// at the org's per-document rate (USD) — the charge the client sees. The
// rate is editable (admin only) with a greyed-until-changed Save button and
// its saved-on date. "Pay now" charges the suggested amount via Stripe
// Checkout; "Manage billing" opens Stripe's own Billing Portal, where a
// customer can see past receipts and update their saved card themselves —
// Flow never builds card-entry UI of its own. Authored by Araza.

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
  // Plain "user" members don't see cost/usage — admin-and-auditor territory.
  if (org.role === "user") redirect("/dashboard");
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
  const chartMonths = [...months].reverse().slice(-6); // oldest-to-newest, last 6
  const maxMonthCount = Math.max(1, ...chartMonths.map(([, c]) => c));
  const monthLabel = (key: string) => {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short" });
  };

  const totalCount = (events ?? []).length;
  const totalCharge = totalCount * rate;
  const canPay = totalCount > 0 && stripeConfigured;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/dashboard"
        className="text-sm text-brand-muted hover:text-brand-navy hover:underline"
      >
        ← Back to dashboard
      </Link>

      <div className="mt-3 flex items-baseline justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-brand-green-dark">
            {org.name}
          </p>
          <h1 className="font-display text-2xl font-extrabold text-brand-ink">
            Billing &amp; usage
          </h1>
        </div>
      </div>
      <p className="mt-1 text-sm text-brand-muted">
        Documents processed at{" "}
        <span className="font-semibold text-brand-navy">${rate.toFixed(2)} USD</span> each.
        Always billed in USD, wherever you&apos;re based.
      </p>

      {searchParams.payment === "success" && (
        <div className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          Payment complete — thank you!
        </div>
      )}
      {searchParams.payment === "cancelled" && (
        <div className="mt-4 rounded-lg border border-brand-line bg-brand-mist px-4 py-3 text-sm text-brand-muted">
          Payment cancelled — nothing was charged.
        </div>
      )}

      {/* Summary */}
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
            Documents processed
          </div>
          <div className="mt-1.5 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
            {totalCount.toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
            Suggested charge
          </div>
          <div className="mt-1.5 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
            {totalCharge.toLocaleString(undefined, {
              style: "currency",
              currency: "USD",
            })}
          </div>
        </div>
      </div>

      {/* Usage trend */}
      {chartMonths.length > 0 && (
        <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
            Last {chartMonths.length} month{chartMonths.length === 1 ? "" : "s"}
          </div>
          <div className="mt-4 flex h-28 items-end gap-3">
            {chartMonths.map(([key, count]) => (
              <div key={key} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="flex h-20 w-full items-end">
                  <div
                    className="w-full rounded-t-md bg-brand-green"
                    style={{ height: `${Math.max(6, (count / maxMonthCount) * 100)}%` }}
                    title={`${count} document${count === 1 ? "" : "s"}`}
                  />
                </div>
                <div className="text-[11px] font-medium text-brand-muted">
                  {monthLabel(key)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Payment */}
      <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
        <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
          Payment
        </div>
        {stripeConfigured ? (
          <>
            {canPay ? (
              <p className="mt-2 text-sm text-slate-600">
                Pay the suggested charge of{" "}
                <strong className="text-brand-ink">
                  {totalCharge.toLocaleString(undefined, {
                    style: "currency",
                    currency: "USD",
                  })}
                </strong>{" "}
                ({totalCount} document{totalCount === 1 ? "" : "s"} ×{" "}
                {rate.toFixed(2)}), or manage your saved payment method and past
                receipts any time.
              </p>
            ) : (
              <p className="mt-2 text-sm text-brand-muted">
                No usage to bill yet — documents processed will appear here.
                You can still add a payment method ahead of time below.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-start gap-3">
              {canPay && (
                <StripeCheckoutButton action={createUsageCheckout} label="Pay now" pendingLabel="Opening checkout…" />
              )}
              <StripeCheckoutButton
                action={createBillingPortalSession}
                label="Manage billing"
                pendingLabel="Opening billing portal…"
                variant="secondary"
              />
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-brand-muted">
            Stripe is not connected yet. Set{" "}
            <code className="rounded bg-brand-mist px-1 py-0.5 text-brand-navy">STRIPE_SECRET_KEY</code>{" "}
            to enable payments.
          </p>
        )}
      </section>

      {/* Rate per document */}
      <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
        <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
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

      {/* By month */}
      <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
        <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
          By month
        </div>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-brand-line text-left text-xs text-brand-muted">
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
                <td colSpan={3} className="py-4 text-center text-brand-muted">
                  No documents processed yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Recent documents */}
      <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
        <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
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
              <span className="flex-none text-xs text-brand-muted">
                {e.source === "email" ? "email" : "upload"} ·{" "}
                {new Date(e.created_at).toLocaleString()}
              </span>
            </li>
          ))}
          {(events ?? []).length === 0 && (
            <li className="py-4 text-center text-brand-muted">Nothing yet.</li>
          )}
        </ul>
      </section>
    </main>
  );
}
