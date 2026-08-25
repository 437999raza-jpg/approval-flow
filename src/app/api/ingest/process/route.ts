// Background extraction worker (Hobby-friendly poller). The UI polls this
// every few seconds; each call processes ONE queued ingest job for the
// signed-in user's org (the 20-60s OpenRouter extraction runs here, not in
// the upload/email request path). Returns whether anything ran and how many
// jobs remain queued so the poller can slow down when idle.
// Swapping in Vercel Cron (Pro) or Inngest later = calling
// runNextIngestJob from a scheduled job instead of this endpoint.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { runNextIngestJob } from "@/lib/ingest-queue";
import { INVOICES_TAG } from "@/lib/org-cache";

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const org = await getCurrentOrg(supabase);
  if (!org) {
    return NextResponse.json({ error: "No organization" }, { status: 400 });
  }

  const result = await runNextIngestJob(supabase, org.id);
  if (result.ran) {
    // A job finished (invoice created / split pending / failed) — refresh
    // the cached invoice list and let the poller's router.refresh() pick it
    // up on the page.
    revalidateTag(INVOICES_TAG);
  }
  return NextResponse.json(result);
}
