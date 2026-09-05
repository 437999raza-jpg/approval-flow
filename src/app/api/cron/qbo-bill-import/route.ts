export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQboBillImportJob } from "@/lib/qbo-bill-import";
import { authorizeCronRequest } from "@/lib/cron-auth";

// Every 2 minutes: drives any active historical-bill-import job
// (qbo_bill_import_jobs, migration 0104) — the platform-admin-only tool
// for onboarding a customer's pre-Flow QuickBooks history. One batch per
// org per tick, same shape as /api/cron/ingest-process, so a job with a
// large backlog finishes over several ticks rather than one long request.
// Authored by Araza.
export const dynamic = "force-dynamic";
// force-dynamic alone doesn't stop Next.js from caching individual fetch()
// calls made inside the route (including ones the Supabase client makes
// under the hood) — force-no-store guarantees every fetch here hits the
// live database instead of a stale cached response. This is exactly the
// bug that left qbo_bill_import_jobs stuck at "queued" forever: the job
// lookup query kept getting served a cached "no active jobs" response.
export const fetchCache = "force-no-store";

export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const { data: active } = await admin
    .from("qbo_bill_import_jobs")
    .select("organization_id")
    .in("status", ["queued", "processing"]);

  const orgIds = [...new Set((active ?? []).map((r) => r.organization_id))];
  const errors: string[] = [];
  for (const orgId of orgIds) {
    try {
      await runQboBillImportJob(admin, orgId);
    } catch (err) {
      errors.push(`${orgId}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return NextResponse.json({ orgsProcessed: orgIds.length, errors });
}
