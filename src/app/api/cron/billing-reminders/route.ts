// "We have to build it" — a customer's usage payment is a manual
// "Pay now" click on the Billing page, never an auto-charged
// subscription, so nothing today notices if they simply stop clicking
// it. isOrgLocked() only checks trial-end + whether a plan is
// SELECTED, never whether it's actually been PAID for recently.
// Explicitly scoped as "remind, don't lock" — this only emails, it
// never restricts access.
//
// Daily job (see vercel.json). Reminds once per ~35-day-overdue window
// (usage_reminder_sent_at, cleared by the Stripe webhook on a fresh
// payment) rather than every single day an org stays unpaid.
//
// Authored by Araza.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePlan, isTrialActive, computeOverage } from "@/lib/plans";
import { getAppUrl } from "@/lib/app-url";
import { platformAdminEmails } from "@/lib/platform-admin";
import { sendUsagePaymentReminderEmail, sendUsagePaymentOverdueAdminAlert, sendCronErrorAlert } from "@/lib/notify";
import { authorizeCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
// force-dynamic alone doesn't stop Next.js from caching individual fetch()
// calls made inside the route (including ones the Supabase client makes
// under the hood) — force-no-store guarantees every fetch here hits the
// live database instead of a stale cached response.
export const fetchCache = "force-no-store";

const OVERDUE_AFTER_DAYS = 35;
const RENOTIFY_AFTER_DAYS = 7;

function daysSince(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000);
}

export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const appUrl = getAppUrl();

  const { data: orgs } = await admin
    .from("organizations")
    .select(
      "id, name, plan, custom_plan, is_internal, trial_ends_at, usage_last_paid_at, usage_reminder_sent_at, autopay_enabled, stripe_customer_id, last_overage_billed_month"
    );

  const adminEmails = platformAdminEmails();
  const emailById = new Map<string, string | null>();
  const getEmail = async (userId: string): Promise<string | null> => {
    if (emailById.has(userId)) return emailById.get(userId)!;
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data.user?.email ?? null;
    emailById.set(userId, email);
    return email;
  };

  let remindersSent = 0;

  for (const org of orgs ?? []) {
    if (org.is_internal) continue;
    if (!resolvePlan(org)) continue; // no plan chosen — nothing to be paying for yet
    if (isTrialActive(org.trial_ends_at)) continue; // still free, not expected to pay
    // Autopay orgs are handled entirely by the Stripe webhook
    // (invoice.payment_failed/succeeded) — this "click Pay now" nudge
    // would be the wrong instruction for someone whose card is charged
    // automatically.
    if (org.autopay_enabled) continue;

    if (daysSince(org.usage_last_paid_at) < OVERDUE_AFTER_DAYS) continue;
    if (daysSince(org.usage_reminder_sent_at) < RENOTIFY_AFTER_DAYS) continue;

    const { data: members } = await admin
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id)
      .eq("role", "admin");
    const orgAdminEmails = (
      await Promise.all((members ?? []).map((m) => getEmail(m.user_id)))
    ).filter((e): e is string => !!e);
    if (orgAdminEmails.length === 0) continue; // no one to tell — don't mark it sent

    const daysOverdue = Math.round(daysSince(org.usage_last_paid_at));
    const billingUrl = `${appUrl}/billing`;
    const orgSettingsUrl = `${appUrl}/admin/organizations`;

    await Promise.all([
      ...orgAdminEmails.map((to) =>
        sendUsagePaymentReminderEmail({ to, orgName: org.name, billingUrl })
      ),
      ...adminEmails.map((to) =>
        sendUsagePaymentOverdueAdminAlert({
          to,
          orgName: org.name,
          daysSincePaid: daysOverdue,
          orgSettingsUrl,
        })
      ),
    ]);

    await admin
      .from("organizations")
      .update({ usage_reminder_sent_at: new Date().toISOString() })
      .eq("id", org.id);
    remindersSent++;
  }

  // Autopay overage: the subscription (migration 0119) only covers the
  // base plan price, so each completed calendar month's overage is
  // billed here as a one-off Stripe invoice item, which Stripe sweeps
  // into that customer's next subscription invoice automatically — no
  // separate charge/redirect needed. last_overage_billed_month is the
  // idempotency guard against a cron re-run double-billing the same
  // month; it's stamped even when overageDocs is 0, so a quiet month is
  // marked done too, not re-checked forever.
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthKey = `${prevMonthStart.getFullYear()}-${String(prevMonthStart.getMonth() + 1).padStart(2, "0")}`;
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let overageBilled = 0;
  const overageErrors: string[] = [];

  for (const org of orgs ?? []) {
    if (!org.autopay_enabled || !org.stripe_customer_id) continue;
    if (org.last_overage_billed_month === prevMonthKey) continue;

    const plan = resolvePlan(org);
    if (!plan) continue;

    try {
      const { count } = await admin
        .from("usage_events")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .gte("created_at", prevMonthStart.toISOString())
        .lt("created_at", currentMonthStart.toISOString());
      const { overageDocs, overageUsd } = computeOverage(plan, count ?? 0);

      if (overageDocs > 0) {
        if (!stripeSecret) {
          overageErrors.push(`${org.id}: STRIPE_SECRET_KEY missing, could not bill ${overageDocs} overage docs`);
        } else {
          const res = await fetch("https://api.stripe.com/v1/invoiceitems", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${stripeSecret}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              customer: org.stripe_customer_id,
              currency: "usd",
              amount: String(Math.round(overageUsd * 100)),
              description: `${overageDocs} document${overageDocs === 1 ? "" : "s"} over the ${plan.includedDocs}-document plan limit (${prevMonthKey})`,
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            overageErrors.push(`${org.id}: Stripe invoice item failed (${res.status}): ${text.slice(0, 200)}`);
            continue; // don't stamp last_overage_billed_month — retry tomorrow
          }
        }
      }

      await admin
        .from("organizations")
        .update({ last_overage_billed_month: prevMonthKey })
        .eq("id", org.id);
      overageBilled++;
    } catch (err) {
      overageErrors.push(`${org.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (overageErrors.length > 0) {
    await Promise.all(
      adminEmails.map((to) =>
        sendCronErrorAlert({ to, jobName: "Autopay overage billing", errors: overageErrors })
      )
    );
  }

  return NextResponse.json({ ok: true, remindersSent, overageBilled, overageErrors });
}
