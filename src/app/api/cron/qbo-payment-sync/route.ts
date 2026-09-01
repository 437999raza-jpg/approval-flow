export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getQboConnection, runQboPaymentSync } from "@/lib/qbo";
import { authorizeCronRequest } from "@/lib/cron-auth";

// Nightly (see vercel.json's "crons" entry): pulls payment status
// (paid/unpaid + date paid) from QuickBooks for every bill each connected
// org has already synced there. Same core logic as the manual "Sync
// payment status" button in Settings (src/lib/dashboard-actions.ts,
// syncQboPaymentStatus) — see runQboPaymentSync in qbo.ts. Authored by
// Araza.
export const dynamic = "force-dynamic";

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

  return NextResponse.json({ ok: true, orgsChecked, totalUpdated, errors });
}
