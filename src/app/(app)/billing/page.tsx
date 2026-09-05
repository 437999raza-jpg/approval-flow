import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { selectPlan, createUsageCheckout, createBillingPortalSession, confirmSetupFeePayment, enableAutopay } from "@/lib/dashboard-actions";
import { StripeCheckoutButton } from "@/components/StripeCheckoutButton";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { SubmitButton } from "@/components/SubmitButton";
import { PLANS, PLAN_ORDER, isTrialActive, resolvePlan, resolveSetupFee, computeOverage } from "@/lib/plans";

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
  searchParams: { payment?: string; autopay?: string; error?: string; session_id?: string };
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
      .select(
        "plan, custom_plan, is_internal, plan_selected_at, trial_ends_at, setup_fee_usd, setup_fee_label, setup_fee_paid_at, autopay_enabled"
      )
      .eq("id", org.id)
      .single(),
  ]);
  // Returning from Stripe with a session that included the setup fee —
  // stamp it paid before rendering. orgRow was read before that write
  // landed, so apply the same stamp locally rather than re-querying, and
  // only when the confirmation actually succeeded.
  const setupFeeJustPaid =
    searchParams.payment === "success" && searchParams.session_id
      ? await confirmSetupFeePayment(searchParams.session_id)
      : false;

  // A house account (Ufirst's own production org) has full access and is
  // never invoiced. Everything that asks it for money is suppressed
  // rather than shown-and-ignored — a "Pay now" button for money that
  // will never move is just a trap for whoever clicks it.
  const isInternal = orgRow?.is_internal === true;
  const currentPlan = resolvePlan(orgRow);
  const setupFee = isInternal ? null : resolveSetupFee(
    setupFeeJustPaid
      ? { ...orgRow, setup_fee_paid_at: new Date().toISOString() }
      : orgRow
  );
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
    currentPlan ? currentPlan.priceUsd + computeOverage(currentPlan, count).overageUsd : null;

  const thisMonthKey = monthKey(new Date().toISOString());
  const thisMonthCount = byMonth.get(thisMonthKey) ?? 0;
  const overageDocs = currentPlan ? computeOverage(currentPlan, thisMonthCount).overageDocs : 0;
  const totalCharge = currentPlan ? monthCost(thisMonthCount)! : 0;
  const canPay = Boolean(currentPlan) && stripeConfigured;
  const totalCount = (events ?? []).length;
  const autopayEnabled = orgRow?.autopay_enabled === true;
  const canEnableAutopay = Boolean(currentPlan) && currentPlan?.isCustom === false && stripeConfigured && !autopayEnabled;
  const nextAutopayCharge = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1, 1);
    return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  })();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-green-dark">
            {org.name}
          </p>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-brand-ink">
            Billing &amp; usage
          </h1>
        </div>
      </div>
      {/* The USD note is highlighted deliberately: every price on this
          page is USD, but the app shows CAD throughout (invoices, totals,
          the usage charge), so this is exactly the line a reader skims
          past and queries later. A house account never pays, so the
          currency it would pay in is noise. */}
      <p className="mt-1 text-sm text-brand-muted">
        {isInternal
          ? "Internal account — full access to everything, never billed."
          : currentPlan
            ? `On the ${currentPlan.name} plan — ${currentPlan.includedDocs} documents/month included.`
            : trialing
              ? `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left in your free trial — full access, no plan needed yet.`
              : trialLapsed
                ? "Your trial has ended — choose a plan below to keep approving and adding invoices."
                : "Choose a plan below to get started."}{" "}
        {!isInternal && (
          <mark className="rounded bg-amber-200/70 px-1 py-0.5 font-medium text-brand-ink">
            Always billed in USD, wherever you&apos;re based.
          </mark>
        )}
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
      {searchParams.autopay === "connected" && (
        <div className="mt-4 rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          Autopay is on — nothing to do from here on.
        </div>
      )}
      {searchParams.autopay === "cancelled" && (
        <div className="mt-4 rounded-lg border border-brand-line bg-brand-mist px-4 py-3 text-sm text-brand-muted">
          Autopay setup cancelled — nothing changed, &quot;Pay now&quot; still works as before.
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
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          Plan
        </div>
        {isInternal ? (
          <div className="mt-2 rounded-xl border border-brand-line bg-white p-6 shadow-elevation-1 shadow-brand-ink/5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-lg font-extrabold text-brand-ink">
                {currentPlan?.name ?? "Full access"}
              </span>
              <span className="rounded-full bg-brand-green/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-green-dark">
                Internal account
              </span>
            </div>
            <p className="mt-2 text-sm text-brand-muted">
              This is a house account. Every feature is on, nothing is metered
              against a limit, and no invoice is ever raised for it.
            </p>
          </div>
        ) : currentPlan?.isCustom ? (
          /* A negotiated plan replaces the tier grid outright. Showing
             four standard tiers underneath an agreed deal invites exactly
             the question we don't want ("am I on the wrong one?") — and
             switching to a fixed tier is a conversation, not a button. */
          <div className="mt-2 rounded-xl border-2 border-brand-green bg-white p-6 shadow-elevation-2 shadow-brand-ink/5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-lg font-extrabold text-brand-ink">
                {currentPlan.name}
              </span>
              <span className="rounded-full bg-brand-green/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-green-dark">
                Custom plan
              </span>
            </div>
            <div className="mt-2 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
              ${currentPlan.priceUsd.toLocaleString()}
              <span className="text-sm font-medium text-brand-muted"> USD/mo</span>
            </div>
            <p className="mt-1 text-sm text-brand-muted">
              {currentPlan.includedDocs.toLocaleString()} documents included, then $
              {currentPlan.overageRatePerDoc.toFixed(2)}/doc.
            </p>
            <p className="mt-3 text-sm text-brand-muted">{currentPlan.blurb}</p>
            <p className="mt-4 border-t border-brand-line pt-3 text-xs text-brand-muted">
              This plan was agreed with you directly. To change it, talk to us —{" "}
              <a href="mailto:hello@ufirst.co" className="font-medium text-brand-green-dark underline">
                hello@ufirst.co
              </a>
              .
            </p>
          </div>
        ) : (
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((id) => {
            const plan = PLANS[id];
            const active = currentPlan?.id === id;
            return (
              <div
                key={id}
                className={`flex flex-col rounded-xl border p-5 shadow-elevation-1 shadow-brand-ink/5 ${
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
                {/* "USD" sits on the price itself, not just in the note
                    above: invoices elsewhere in the app render as
                    CA$1,053.39, so a bare "$299" on the same screen
                    family is genuinely ambiguous to a Canadian reader. */}
                <div className="mt-2 font-display text-2xl font-extrabold tabular-nums text-brand-ink">
                  ${plan.priceUsd}
                  <span className="text-sm font-medium text-brand-muted"> USD/mo</span>
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
        )}
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

      {/* One-time build fee. Deliberately its own card rather than a line
          in "this month's charge" — it is not monthly, and folding it in
          would make the recurring number look like it jumped. */}
      {setupFee && (
        <section
          className={`mt-4 rounded-xl border p-5 shadow-elevation-1 shadow-brand-ink/5 ${
            setupFee.outstanding ? "border-amber-300 bg-amber-50" : "border-brand-line bg-white"
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                One-time setup fee
              </div>
              <p className="mt-1 font-display text-lg font-extrabold text-brand-ink">
                {setupFee.label}
              </p>
              <p className="mt-1 text-sm text-brand-muted">
                {setupFee.outstanding
                  ? "Charged once, on your next payment — not part of the monthly plan."
                  : `Paid on ${new Date(setupFee.paidAt!).toLocaleDateString()}.`}
              </p>
            </div>
            <div className="text-right">
              <div className="font-display text-2xl font-extrabold tabular-nums text-brand-ink">
                {setupFee.amountUsd.toLocaleString(undefined, {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 0,
                })}
              </div>
              <span
                className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  setupFee.outstanding
                    ? "bg-amber-200 text-amber-900"
                    : "bg-brand-green/15 text-brand-green-dark"
                }`}
              >
                {setupFee.outstanding ? "Due" : "Paid"}
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Summary */}
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
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
        <div className="rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
            This month&apos;s charge
          </div>
          <div className="mt-1.5 font-display text-3xl font-extrabold tabular-nums text-brand-ink">
            {isInternal
              ? "Not billed"
              : currentPlan
                ? totalCharge.toLocaleString(undefined, { style: "currency", currency: "USD" })
                : "—"}
          </div>
        </div>
      </div>

      {/* Usage trend */}
      {chartMonths.length > 0 && (
        <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
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

      {/* Payment — absent entirely for a house account rather than
          disabled: there is no card to add and no charge to settle. */}
      {!isInternal && (
      <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          Payment
        </div>
        {stripeConfigured ? (
          <>
            {autopayEnabled ? (
              <p className="mt-2 text-sm text-slate-600">
                <strong className="text-brand-ink">Autopay is on.</strong> The{" "}
                {currentPlan!.name} plan price is charged automatically each
                month; next charge on{" "}
                <strong className="text-brand-ink">{nextAutopayCharge}</strong>.
                Any overage from the month before is billed automatically at
                the same time. Update your card or cancel autopay any time
                below.
              </p>
            ) : canPay ? (
              <>
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
                {/* The one-time fee rides on the same Checkout session, so
                    the button charges more than the monthly figure above —
                    say so here rather than letting Stripe be the first
                    place they find out. */}
                {setupFee?.outstanding && (
                  <p className="mt-2 text-sm font-medium text-amber-800">
                    Plus the one-time {setupFee.label} fee of{" "}
                    {setupFee.amountUsd.toLocaleString(undefined, {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    })}
                    {" — "}
                    <strong className="text-brand-ink">
                      {(totalCharge + setupFee.amountUsd).toLocaleString(undefined, {
                        style: "currency",
                        currency: "USD",
                      })}
                    </strong>{" "}
                    total on this payment.
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-brand-muted">
                Choose a plan above before paying. You can still add a payment
                method ahead of time below.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-start gap-3">
              {/* Opt-in, no deadline — "Pay now" never goes away for
                  anyone who'd rather keep paying manually; this is
                  purely an additional choice, shown only while autopay
                  isn't already on. */}
              {!autopayEnabled && canPay && (
                <StripeCheckoutButton action={createUsageCheckout} label="Pay now" pendingLabel="Opening checkout…" />
              )}
              {canEnableAutopay && (
                <StripeCheckoutButton
                  action={enableAutopay}
                  label="Enable autopay"
                  pendingLabel="Setting up autopay…"
                  variant="secondary"
                />
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
      )}

      {/* By month */}
      <section className="mt-4 rounded-xl border border-brand-line bg-white p-5 shadow-elevation-1 shadow-brand-ink/5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          By month
        </div>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-brand-line text-left text-xs text-brand-muted">
              <th className="py-1.5 font-medium">Month</th>
              <th className="py-1.5 text-right font-medium">Documents</th>
              {!isInternal && (
                <th className="py-1.5 text-right font-medium">Est. charge</th>
              )}
            </tr>
          </thead>
          <tbody>
            {months.map(([month, count]) => {
              const cost = monthCost(count);
              return (
                <tr key={month} className="border-b border-slate-100">
                  <td className="py-1.5">{month}</td>
                  <td className="py-1.5 text-right tabular-nums">{count}</td>
                  {!isInternal && (
                    <td className="py-1.5 text-right tabular-nums">
                      {cost !== null
                        ? cost.toLocaleString(undefined, { style: "currency", currency: "USD" })
                        : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
            {months.length === 0 && (
              <tr>
                <td colSpan={isInternal ? 2 : 3} className="py-4 text-center text-brand-muted">
                  No documents processed yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Recent documents — collapsible since this list can run long */}
      <div className="mt-4 overflow-hidden rounded-xl border border-brand-line bg-white shadow-elevation-1 shadow-brand-ink/5">
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
