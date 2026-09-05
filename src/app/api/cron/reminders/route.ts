import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeOrgPending } from "@/lib/reminders";
import { sendDigestEmail, sendEscalationEmail, sendNoApproverMatchEmail, sendTrialEndingSoonEmail } from "@/lib/notify";
import { getAppUrl } from "@/lib/app-url";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { resolvePlan, isTrialActive } from "@/lib/plans";
import { getNotificationPreferencesMap, prefsFor, isDigestDue } from "@/lib/notification-preferences";

// Reads request.headers directly (not next/headers' headers()) and touches
// no cookies, so Next has no signal to treat this as dynamic on its own —
// without this it gets optimized as a static route (built and cached once
// at build time instead of re-run on every cron trigger).
export const dynamic = "force-dynamic";
// force-dynamic alone doesn't stop Next.js from caching individual fetch()
// calls made inside the route (including ones the Supabase client makes
// under the hood) — force-no-store guarantees every fetch here hits the
// live database instead of a stale cached response.
export const fetchCache = "force-no-store";

// Hourly job (see vercel.json's "crons" entry — moved from once daily so
// each approver's own digest_days/digest_hour/timezone preference,
// migration 0115, can actually be honored): sends every approver a
// digest of what's currently waiting on them, and escalates to org
// admins anything that's blown well past its step's deadline. Vercel
// signs cron-triggered requests with a bearer token matching the
// CRON_SECRET env var — reject anything else so this can't be hit
// (and made to spam every user's inbox) by an outside request.
// Authored by Araza.
export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const appUrl = getAppUrl();

  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, is_internal, plan, custom_plan, trial_ends_at, trial_reminder_sent_at");
  // Per-user lookups (cached, not re-fetched for the same person across
  // orgs), not a bulk listUsers({ perPage: 1000 }) — that silently
  // truncates past 1000 users platform-wide, meaning any approver beyond
  // the first page got no email and was skipped with no error, every
  // day, indefinitely. Same anti-pattern already found and fixed
  // elsewhere this session (support chat, @mentions, "it's your turn",
  // rejections, /workflows).
  const emailById = new Map<string, string | null>();
  const getEmail = async (userId: string): Promise<string | null> => {
    if (emailById.has(userId)) return emailById.get(userId)!;
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data.user?.email ?? null;
    emailById.set(userId, email);
    return email;
  };

  let digestsSent = 0;
  let escalationsSent = 0;
  let noApproverNoticesSent = 0;
  let trialRemindersSent = 0;
  const NO_APPROVER_RENOTIFY_DAYS = 3;
  const TRIAL_REMINDER_WITHIN_DAYS = 3;

  for (const org of orgs ?? []) {
    // "No trial-ending email exists at all" — TrialBanner is in-app
    // only, so this is the sole warning anyone gets if they're not
    // actively looking at flow in the final days. One-shot per trial.
    if (
      !org.is_internal &&
      !resolvePlan(org) &&
      isTrialActive(org.trial_ends_at) &&
      !org.trial_reminder_sent_at
    ) {
      const daysLeft = Math.ceil(
        (new Date(org.trial_ends_at as string).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      );
      if (daysLeft <= TRIAL_REMINDER_WITHIN_DAYS) {
        const { data: trialAdmins } = await admin
          .from("organization_members")
          .select("user_id")
          .eq("organization_id", org.id)
          .eq("role", "admin");
        const trialAdminEmails = (
          await Promise.all((trialAdmins ?? []).map((a) => getEmail(a.user_id)))
        ).filter((e): e is string => !!e);
        if (trialAdminEmails.length > 0) {
          await Promise.all(
            trialAdminEmails.map((to) =>
              sendTrialEndingSoonEmail({
                to,
                orgName: org.name,
                daysLeft: Math.max(1, daysLeft),
                billingUrl: `${appUrl}/billing`,
              })
            )
          );
          await admin
            .from("organizations")
            .update({ trial_reminder_sent_at: new Date().toISOString() })
            .eq("id", org.id);
          trialRemindersSent++;
        }
      }
    }

    const { byApprover, escalations, noApprover } = await computeOrgPending(org.id);

    // This cron now runs hourly (vercel.json) instead of once daily, so
    // each approver's own digest_days/digest_hour/timezone (migration
    // 0115) decides which single hourly run is actually theirs — everyone
    // else's run for that user is a no-op via isDigestDue's day/hour
    // check. Escalations/no-approver/trial-reminder below are unaffected:
    // they're already idempotent on their own sent-at timestamps, so
    // running hourly instead of daily just catches them sooner, never
    // twice.
    const digestPrefsMap = await getNotificationPreferencesMap(admin, [...byApprover.keys()]);
    const digestNow = new Date();
    for (const [userId, items] of byApprover) {
      const prefs = prefsFor(digestPrefsMap, userId);
      if (!isDigestDue(prefs, digestNow)) continue;
      const email = await getEmail(userId);
      if (!email) continue;
      await sendDigestEmail({
        to: email,
        items: items.map((i) => ({
          label: i.label,
          daysOnStep: i.daysOnStep,
          overdue: i.overdue,
          url: `${appUrl}/dashboard/${i.invoiceId}`,
        })),
        dashboardUrl: `${appUrl}/dashboard`,
      });
      await admin
        .from("user_notification_preferences")
        .upsert({ user_id: userId, digest_last_sent_at: digestNow.toISOString() });
      digestsSent++;
    }

    if (escalations.length > 0) {
      const { data: admins } = await admin
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", org.id)
        .eq("role", "admin");
      // {userId, email} pairs, not two separately-filtered arrays — an
      // email-only list would go out of sync with the ids the in-app
      // notification row below needs the moment any admin lacks an email.
      const adminRecipients = (
        await Promise.all(
          (admins ?? []).map(async (a) => ({ userId: a.user_id, email: await getEmail(a.user_id) }))
        )
      ).filter((r): r is { userId: string; email: string } => !!r.email);

      const { data: profiles } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", [...new Set(escalations.flatMap((e) => e.approverIds))]);
      const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

      for (const esc of escalations) {
        const stuckOnNames = esc.approverIds.map((id) => nameById.get(id) ?? "someone");
        // A step can nominate who hears about it (migration 0094).
        // Falling back to every admin keeps the pre-0094 behavior for any
        // step nobody has configured, and also covers the case where the
        // nominated person no longer has an email on file — better to
        // over-notify than to let a stuck bill go silent.
        let recipients = adminRecipients;
        if (esc.escalateToUserId) {
          const nominatedEmail = await getEmail(esc.escalateToUserId);
          if (nominatedEmail) recipients = [{ userId: esc.escalateToUserId, email: nominatedEmail }];
        }
        await Promise.all(
          recipients.map((r) =>
            sendEscalationEmail({
              to: r.email,
              invoiceLabel: esc.label,
              stepName: esc.stepName,
              daysOnStep: esc.daysOnStep,
              deadlineDays: esc.deadlineDays,
              stuckOnNames,
              invoiceUrl: `${appUrl}/dashboard/${esc.invoiceId}`,
            })
          )
        );
        // In-app equivalent (migration 0118) — previously escalation
        // only ever reached someone by email, so missing or dismissing
        // that one message left no record it happened at all.
        if (recipients.length > 0) {
          await admin.from("notifications").insert(
            recipients.map((r) => ({
              organization_id: org.id,
              user_id: r.userId,
              invoice_id: esc.invoiceId,
              type: "escalated" as const,
            }))
          );
        }
        escalationsSent++;
        await admin
          .from("invoices")
          .update({ escalated_at: new Date().toISOString() })
          .eq("id", esc.invoiceId);
      }
    }

    // "An invoice can get stuck forever with zero notification to
    // anyone" — these have no approver at all, so they can never earn
    // a digest or an escalation on their own. Re-notified periodically
    // (not once-ever) since nothing else will ever surface one again
    // if a single email gets missed.
    const dueForNotice = noApprover.filter((n) => {
      if (!n.noticeSentAt) return true;
      const daysSinceNotice = (Date.now() - new Date(n.noticeSentAt).getTime()) / (24 * 60 * 60 * 1000);
      return daysSinceNotice >= NO_APPROVER_RENOTIFY_DAYS;
    });
    if (dueForNotice.length > 0) {
      const { data: admins } = await admin
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", org.id)
        .eq("role", "admin");
      const adminRecipients = (
        await Promise.all(
          (admins ?? []).map(async (a) => ({ userId: a.user_id, email: await getEmail(a.user_id) }))
        )
      ).filter((r): r is { userId: string; email: string } => !!r.email);

      if (adminRecipients.length > 0) {
        const items = dueForNotice.map((n) => ({
          label: n.label,
          stepName: n.stepName,
          url: `${appUrl}/dashboard/${n.invoiceId}`,
        }));
        await Promise.all(
          adminRecipients.map((r) =>
            sendNoApproverMatchEmail({
              to: r.email,
              orgName: org.name,
              items,
              workflowsUrl: `${appUrl}/workflows`,
            })
          )
        );
        // In-app equivalent (migration 0118), one row per admin per
        // affected invoice — same reach as the email above, which lists
        // every stuck invoice in one message per admin.
        await admin.from("notifications").insert(
          adminRecipients.flatMap((r) =>
            dueForNotice.map((n) => ({
              organization_id: org.id,
              user_id: r.userId,
              invoice_id: n.invoiceId,
              type: "no_approver" as const,
            }))
          )
        );
        const now = new Date().toISOString();
        await Promise.all(
          dueForNotice.map((n) =>
            admin.from("invoices").update({ no_approver_notice_sent_at: now }).eq("id", n.invoiceId)
          )
        );
        noApproverNoticesSent += dueForNotice.length;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    digestsSent,
    escalationsSent,
    noApproverNoticesSent,
    trialRemindersSent,
  });
}
