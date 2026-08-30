import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { selectPlan, createUsageCheckout, createBillingPortalSession } from "@/lib/dashboard-actions";
import { StripeCheckoutButton } from "@/components/StripeCheckoutButton";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { SubmitButton } from "@/components/SubmitButton";
import { PLANS, PLAN_ORDER, isPlanId, isTrialActive } from "@/lib/plans";
import { BackToDashboardButton } from "@/components/BackToDashboardButton";

// Flow's billing: a fixed monthly plan (Starter/Growth/Scale) rather than
// an admin-editable $/document rate — see src/lib/plans.ts for how these
// were priced. "Pay now" charges this calendar month's plan fee + any
// overage via Stripe Checkout; "Manage billing" opens Stripe's own
// Billing Portal, where a customer can see past receipts and update
// their saved card themselves — Flow never builds card-entry UI of its
// own. Authored by Araza.

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { payment?: string; error?: string };
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
      .select("plan, plan_selected_at, trial_ends_at")
      .eq("id", org.id)
      .single(),
  ]);
  const currentPlan = isPlanId(orgRow?.plan) ? PLANS[orgRow.plan] : null;
  const planSelectedAt = orgRow?.plan_selected_at ?? null;
  const trialEndsAt = orgRow?.trial_ends_at ?? null;
  const trialing = trialEndsAt != null && !currentPlan && isTrialActive(trialEndsAt);
  const trialLapsed = trialEndsAt != null && !currentPlan && !isTrialActive(trialEndsAt);
  const trialDaysLeft = trialing
    ? Math.max(1, Math.ceil((new Date(trialEndsAt!).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0;

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
  const monthCost = (count: number) =>
    currentPlan
      ? currentPlan.priceUsd + Math.max(0, count - currentPlan.includedDocs) * currentPlan.overageRatePerDoc
      : null;

  const thisMonthKey = monthKey(new Date().toISOString());
  const thisMonthCount = byMonth.get(thisMonthKey) ?? 0;
  const overageDocs = currentPlan ? Math.max(0, thisMonthCount - currentPlan.includedDocs) : 0;
  const totalCharge = currentPlan ? monthCost(thisMonthCount)! : 0;
  const canPay = Boolean(currentPlan) && stripeConfigured;
  const totalCount = (events ?? []).length;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <BackToDashboardButton />

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
        {currentPlan
          ? `On the ${currentPlan.name} plan — ${currentPlan.includedDocs} documents/month included.`
          : trialing
            ? `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left in your free trial — full access, no plan needed yet.`
            : trialLapsed
              ? "Your trial has ended — choose a plan below to keep approving and adding invoices."
              : "Choose a plan below to get started."}{" "}
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
      {searchParams.error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {searchParams.error === "plan-not-admin"
            ? "Only admins can change the plan."
            : "Could not save the plan — try again."}
        </div>
      )}

      {/* Plans */}
      <section className="mt-6">
        <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
          Plan
        </div>
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((id) => {
            const plan = PLANS[id];
            const active = currentPlan?.id === id;
            return (
              <div
                key={id}
                className={`flex flex-col rounded-xl border p-5 shadow-sm shadow-brand-ink/5 ${
                  active ? "border-brand-green bg-white ring-2 ring-brand-green-light/50" : "border-brand-line bg-white"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-display text-base font-extrabold text-brand-ink">
                    {plan.name}
                  </span>
                  {active && (
                    <span className="rounded-full bg-brand-green/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-green-dark">
                      Current
                    </span>
                  )}
                </div>
                <div className="mt-2 font-display text-2xl font-extrabold tabular-nums text-brand-ink">
                  ${plan.priceUsd}
                  <span className="text-sm font-medium text-brand-muted">/mo</span>
                </div>
                <p className="mt-1 text-xs text-brand-muted">
                  {plan.includedDocs} documents included, then ${plan.overageRatePerDoc.toFixed(2)}/doc.
                </p>
                <p className="mt-2 flex-1 text-xs text-brand-muted">{plan.blurb}</p>
                {isAdmin && (
                  <form action={selectPlan} className="mt-4">
                    <input type="hidden" name="plan" value={id} />
                    <SubmitButton
                      disabled={active}
                      className={`w-full rounded-lg px-3 py-2 text-sm font-display font-bold ${
                        active
                          ? "cursor-default bg-brand-mist text-brand-muted"
                          : "bg-brand-green text-white hover:bg-brand-green-dark"
                      }`}
                    >
                      {active ? "Selected" : currentPlan ? "Switch to this plan" : "Choose this plan"}
                    </SubmitButton>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        {!isAdmin && !currentPlan && (
          <p className="mt-2 text-sm text-brand-muted">
            No plan selected yet — ask an admin to choose one.
          </p>
        )}
        {planSelectedAt && (
          <p className="mt-2 text-xs text-brand-muted">
            Selected on {new Date(planSelectedAt).toLocaleDateString()}
          </p>
        )}
      </section>

      {/* Summary */}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
            This month&apos;s documents
          </div>
          <div className="mt-1.5 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
            {thisMonthCount.toLocaleString()}
          </div>
          {currentPlan && overageDocs > 0 && (
            <div className="mt-1 text-xs font-medium text-amber-700">
              {overageDocs} over the {currentPlan.includedDocs}-document limit
            </div>
          )}
        </div>
        <div className="rounded-xl border border-brand-line bg-white p-5 shadow-sm shadow-brand-ink/5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
            This month&apos;s charge
          </div>
          <div className="mt-1.5 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
            {currentPlan
              ? totalCharge.toLocaleString(undefined, { style: "currency", currency: "USD" })
              : "—"}
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
                Pay this month&apos;s charge of{" "}
                <strong className="text-brand-ink">
                  {totalCharge.toLocaleString(undefined, {
                    style: "currency",
                    currency: "USD",
                  })}
                </strong>{" "}
                ({currentPlan!.name} plan{overageDocs > 0 ? ` + ${overageDocs} overage doc${overageDocs === 1 ? "" : "s"}` : ""}),
                or manage your saved payment method and past receipts any time.
              </p>
            ) : (
              <p className="mt-2 text-sm text-brand-muted">
                Choose a plan above before paying. You can still add a payment
                method ahead of time below.
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
              <th className="py-1.5 text-right font-medium">Est. charge</th>
            </tr>
          </thead>
          <tbody>
            {months.map(([month, count]) => {
              const cost = monthCost(count);
              return (
                <tr key={month} className="border-b border-slate-100">
                  <td className="py-1.5">{month}</td>
                  <td className="py-1.5 text-right tabular-nums">{count}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {cost !== null
                      ? cost.toLocaleString(undefined, { style: "currency", currency: "USD" })
                      : "—"}
                  </td>
                </tr>
              );
            })}
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

      {/* Recent documents — collapsible since this list can run long */}
      <div className="mt-4 overflow-hidden rounded-xl border border-brand-line bg-white shadow-sm shadow-brand-ink/5">
        <CollapsibleSection title="Recent documents" badge={totalCount} defaultOpen={false}>
          <ul className="divide-y divide-slate-100 text-sm">
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
        </CollapsibleSection>
      </div>
    </main>
  );
}
