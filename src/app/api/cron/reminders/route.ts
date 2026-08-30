import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeOrgPending } from "@/lib/reminders";
import { sendDigestEmail, sendEscalationEmail } from "@/lib/notify";
import { getAppUrl } from "@/lib/app-url";

// Reads request.headers directly (not next/headers' headers()) and touches
// no cookies, so Next has no signal to treat this as dynamic on its own —
// without this it gets optimized as a static route (built and cached once
// at build time instead of re-run on every cron trigger).
export const dynamic = "force-dynamic";

// Daily job (see vercel.json's "crons" entry): sends every approver a
// digest of what's currently waiting on them, and escalates to org
// admins anything that's blown well past its step's deadline. Vercel
// signs cron-triggered requests with a bearer token matching the
// CRON_SECRET env var — reject anything else so this can't be hit
// (and made to spam every user's inbox) by an outside request.
// Authored by Araza.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const admin = createAdminClient();
  const appUrl = getAppUrl();

  const { data: orgs } = await admin.from("organizations").select("id");
  const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map((authUsers?.users ?? []).map((u) => [u.id, u.email ?? null]));

  let digestsSent = 0;
  let escalationsSent = 0;

  for (const org of orgs ?? []) {
    const { byApprover, escalations } = await computeOrgPending(org.id);

    for (const [userId, items] of byApprover) {
      const email = emailById.get(userId);
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
      digestsSent++;
    }

    if (escalations.length > 0) {
      const { data: admins } = await admin
        .from("organization_members")
        .select("user_id")
        .eq("organization_id", org.id)
        .eq("role", "admin");
      const adminEmails = (admins ?? [])
        .map((a) => emailById.get(a.user_id))
        .filter((e): e is string => !!e);

      const { data: profiles } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", [...new Set(escalations.flatMap((e) => e.approverIds))]);
      const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

      for (const esc of escalations) {
        const stuckOnNames = esc.approverIds.map((id) => nameById.get(id) ?? "someone");
        await Promise.all(
          adminEmails.map((to) =>
            sendEscalationEmail({
              to,
              invoiceLabel: esc.label,
              stepName: esc.stepName,
              daysOnStep: esc.daysOnStep,
              deadlineDays: esc.deadlineDays,
              stuckOnNames,
              invoiceUrl: `${appUrl}/dashboard/${esc.invoiceId}`,
            })
          )
        );
        escalationsSent++;
        await admin
          .from("invoices")
          .update({ escalated_at: new Date().toISOString() })
          .eq("id", esc.invoiceId);
      }
    }
  }

  return NextResponse.json({ ok: true, digestsSent, escalationsSent });
}
