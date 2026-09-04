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
import { resolvePlan, isTrialActive } from "@/lib/plans";
import { getAppUrl } from "@/lib/app-url";
import { platformAdminEmails } from "@/lib/platform-admin";
import { sendUsagePaymentReminderEmail, sendUsagePaymentOverdueAdminAlert } from "@/lib/notify";
import { authorizeCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

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
    .select("id, name, plan, custom_plan, is_internal, trial_ends_at, usage_last_paid_at, usage_reminder_sent_at");

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

  return NextResponse.json({ ok: true, remindersSent });
}
