import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { getCurrentOrg } from "@/lib/current-org";
import { getAppUrl } from "@/lib/app-url";
import { sendDigestEmail, sendEscalationEmail, sendPdfOnlyRequestEmail, sendInvoiceReceiptEmail, sendQboDisconnectedEmail, sendUsagePaymentReminderEmail, sendUsagePaymentOverdueAdminAlert, sendNoApproverMatchEmail, sendTrialEndingSoonEmail, sendCronErrorAlert } from "@/lib/notify";

// Sends one of each notification tier to the caller's own address, so the
// templates can be reviewed where they actually matter — in a real inbox,
// with the real subject line, real emoji rendering, and Outlook's own
// priority/category handling. None of that is observable from an HTML
// file opened in a browser.
//
// Deliberately locked down two ways: platform admin only, and it can ONLY
// send to the signed-in user's own account email. There's no recipient
// parameter, so this can never be pointed at anyone else.
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const to = user.email;
  if (!to) return NextResponse.json({ error: "no email on account" }, { status: 400 });
  const org = await getCurrentOrg(supabase);
  if (!org) return NextResponse.json({ error: "no organization" }, { status: 400 });

  const appUrl = getAppUrl();
  const dashboardUrl = `${appUrl}/dashboard`;
  const inv = (id: string) => `${dashboardUrl}/${id}`;

  // 1 — nothing overdue: hairline accent, no emoji, no priority headers.
  await sendDigestEmail({
    to,
    dashboardUrl,
    items: [
      { label: "Bill 24296743 — Battlefield Equipment Rentals · CA$1,053.39", daysOnStep: 1, overdue: false, url: inv("sample-1") },
      { label: "Bill 7109 00001 22663 — The Home Depot · CA$50.78", daysOnStep: 2, overdue: false, url: inv("sample-2") },
    ],
  });

  // 2 — 1–2 days late: amber band, ⏰, still no priority flag.
  await sendDigestEmail({
    to,
    dashboardUrl,
    items: [
      { label: "Bill 1063 — Profixio Construction Services Inc. · CA$57,132.80", daysOnStep: 2, overdue: true, url: inv("sample-3") },
      { label: "Bill 2739 — RDK Services · CA$847.50", daysOnStep: 1, overdue: false, url: inv("sample-4") },
    ],
  });

  // 3 — 3+ days late: red band, 🔴, Outlook priority + "Overdue" category.
  await sendDigestEmail({
    to,
    dashboardUrl,
    items: [
      { label: "Bill 1063 — Profixio Construction Services Inc. · CA$57,132.80", daysOnStep: 6, overdue: true, url: inv("sample-3") },
      { label: "Bill IN260148 — Metro Scaffolding Service Ltd. · CA$124,074.00", daysOnStep: 4, overdue: true, url: inv("sample-5") },
      { label: "Bill 4564 — Senoz Electric Inc. · CA$46,959.22", daysOnStep: 3, overdue: true, url: inv("sample-6") },
      { label: "Bill 2739 — RDK Services · CA$847.50", daysOnStep: 1, overdue: false, url: inv("sample-4") },
    ],
  });

  // 4 — escalation: darkest band, 🚨, addressed to whoever the step
  // escalates to rather than the approver sitting on it.
  await sendEscalationEmail({
    to,
    invoiceLabel: "Bill 1063 — Profixio Construction Services Inc. · CA$57,132.80",
    stepName: "PM Approval",
    daysOnStep: 8,
    deadlineDays: 3,
    stuckOnNames: ["Brittany"],
    invoiceUrl: inv("sample-3"),
  });

  // 5 — PDF-only nudge, sent to a vendor whose attachment wasn't a
  // PDF/PNG/JPEG.
  await sendPdfOnlyRequestEmail({
    to,
    organizationId: org.id,
    attachmentNames: ["Fluid invoice 1811 Supervise the concrete footing work. Bolton Ford..docx"],
  });

  // 6 — receipt acknowledgement, sent once an email produced at least
  // one invoice.
  await sendInvoiceReceiptEmail({ to, organizationId: org.id, orgName: "Fluid Construction", invoiceCount: 1 });

  // 7 — QuickBooks disconnected, sent to org admins when the refresh
  // token dies (revoked or expired from inactivity).
  await sendQboDisconnectedEmail({
    to,
    orgName: "Fluid Construction",
    settingsUrl: `${appUrl}/settings#integrations`,
  });

  // 8/9 — usage payment overdue: one to the customer, one to platform
  // admins. "Pay now" is manual, so nothing else would ever notice.
  await sendUsagePaymentReminderEmail({
    to,
    orgName: "Fluid Construction",
    billingUrl: `${appUrl}/billing`,
  });
  await sendUsagePaymentOverdueAdminAlert({
    to,
    orgName: "Fluid Construction",
    daysSincePaid: 37,
    orgSettingsUrl: `${appUrl}/admin/organizations`,
  });

  // 10 — an invoice has no matching approver at all, so it can never
  // earn a digest or an escalation on its own.
  await sendNoApproverMatchEmail({
    to,
    orgName: "Fluid Construction",
    items: [
      { label: "Battlefield Equipment Rentals #24296743", stepName: "CO Team Approval", url: `${appUrl}/dashboard/sample-1` },
    ],
    workflowsUrl: `${appUrl}/workflows`,
  });

  // 11 — trial ending soon, the one warning anyone gets if they're not
  // actively looking at flow in the final days.
  await sendTrialEndingSoonEmail({
    to,
    orgName: "Fluid Construction",
    daysLeft: 2,
    billingUrl: `${appUrl}/billing`,
  });

  // 12 — a background cron hit errors nobody would otherwise see.
  await sendCronErrorAlert({
    to,
    jobName: "QBO payment status sync",
    errors: ["9554c95f-03f3-4a67-a784-7a138510be7b: QBO: query failed (500): Internal Server Error"],
  });

  return NextResponse.json({
    ok: true,
    sentTo: to,
    samples: [
      "1 — due soon (no band, no emoji)",
      "2 — 1–2 days late (amber ⏰)",
      "3 — 3+ days late (red 🔴, high priority)",
      "4 — escalation (dark red 🚨, high priority)",
      "5 — PDF-only nudge",
      "6 — invoice receipt acknowledgement",
      "7 — QuickBooks disconnected",
      "8 — usage payment reminder (customer)",
      "9 — usage payment overdue (platform admin)",
      "10 — no approver matches this invoice",
      "11 — trial ending soon",
      "12 — cron error alert",
    ],
  });
}
