export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runNextIngestJob } from "@/lib/ingest-queue";
import { authorizeCronRequest } from "@/lib/cron-auth";

// Every 2 minutes (see vercel.json's "crons" entry): drives the invoice
// ingestion queue independently of anyone having the app open. Before
// this, runNextIngestJob only ever ran via the browser poller
// (GET /api/ingest/process) — confirmed live that queued jobs could sit
// for hours overnight with nobody watching. Safe to run with the admin
// client: createInvoiceFromFile (invoices.ts) has no auth.uid()
// dependency anywhere in the ingestion path, only organizationId, which
// is passed explicitly here same as the browser path.
//
// Deliberately one job per org per tick, not a loop draining each org's
// whole backlog — a single extraction can take 20-60s and maxDuration is
// 60s total, so frequent scheduling is what drains a backlog, not a
// bigger per-tick batch. Authored by Araza.
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
  const { data: pending } = await admin
    .from("ingest_jobs")
    .select("organization_id")
    .in("status", ["queued", "processing"]);

  const orgIds = [...new Set((pending ?? []).map((r) => r.organization_id))];

  let orgsProcessed = 0;
  const errors: string[] = [];

  for (const orgId of orgIds) {
    try {
      const result = await runNextIngestJob(admin, orgId);
      if (result.ran) orgsProcessed++;
    } catch (err) {
      errors.push(`${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({ ok: true, orgsChecked: orgIds.length, orgsProcessed, errors });
}
