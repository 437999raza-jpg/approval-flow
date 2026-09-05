export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getQboConnection, runQboPaymentSync } from "@/lib/qbo";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { platformAdminEmails } from "@/lib/platform-admin";
import { sendCronErrorAlert } from "@/lib/notify";

// Nightly (see vercel.json's "crons" entry): pulls payment status
// (paid/unpaid + date paid) from QuickBooks for every bill each connected
// org has already synced there. Same core logic as the manual "Sync
// payment status" button in Settings (src/lib/dashboard-actions.ts,
// syncQboPaymentStatus) — see runQboPaymentSync in qbo.ts. Authored by
// Araza.
export const dynamic = "force-dynamic";
// force-dynamic alone doesn't stop Next.js from caching individual fetch()
// calls made inside the route (including ones the Supabase client makes
// under the hood) — force-no-store guarantees every fetch here hits the
// live database instead of a stale cached response.
export const fetchCache = "force-no-store";

export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const { data: connections } = await admin
    .from("qbo_connections")
    .select("organization_id");

  let orgsChecked = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  for (const row of connections ?? []) {
    const conn = await getQboConnection(admin, row.organization_id);
    if (!conn) continue;
    try {
      const result = await runQboPaymentSync(admin, conn, row.organization_id);
      orgsChecked++;
      totalUpdated += result.updated;
    } catch (err) {
      errors.push(
        `${row.organization_id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // "That errors array only ever went into a JSON response nobody
  // reads" — this cron has no human watching it run, unlike the manual
  // "Sync payment status" button, so a real failure needs to reach
  // someone on its own rather than wait for someone to check Vercel's
  // logs.
  if (errors.length > 0) {
    const admins = platformAdminEmails();
    await Promise.all(
      admins.map((to) =>
        sendCronErrorAlert({ to, jobName: "QBO payment status sync", errors })
      )
    );
  }

  return NextResponse.json({ ok: true, orgsChecked, totalUpdated, errors });
}
