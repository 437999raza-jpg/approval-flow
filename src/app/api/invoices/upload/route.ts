// Manual upload path: signed-in user clicks "Add invoice" / drags a file in.
// Returns INSTANTLY — the file goes to storage, a queued upload_log row is
// recorded (the upload queue / Recent uploads show it as "Processing"), and
// an ingest_jobs entry is queued. The 20-60s extraction + invoice creation
// happens in the background (/api/ingest/process poller), so this request
// never blocks and never occupies the single serverless function for a
// minute (see src/lib/ingest-queue.ts).
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { enqueueIngestJob } from "@/lib/ingest-queue";
import { recordUsageEvent } from "@/lib/usage";
import { INVOICES_TAG } from "@/lib/org-cache";

export async function POST(request: Request) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const org = await getCurrentOrg(supabase);
  if (!org) {
    return NextResponse.json({ error: "No organization" }, { status: 400 });
  }
  if (org.role === "auditor") {
    return NextResponse.json(
      { error: "Auditors are read-only and can't add invoices." },
      { status: 403 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Usage billing: count the document once, at acceptance (the queue worker
  // may retry it, but this file was still one processed document).
  await recordUsageEvent(supabase, org.id, file.name, "manual");

  // Record the upload immediately so the queue shows it right away.
  const { data: logRow, error: logError } = await supabase
    .from("upload_log")
    .insert({
      organization_id: org.id,
      user_id: user.id,
      filename: file.name,
      file_type: file.type,
      file_size_bytes: file.size,
      status: "queued",
    })
    .select("id")
    .single();
  if (logError) console.error("upload_log queued insert failed:", logError);

  const jobId = await enqueueIngestJob({
    supabase,
    organizationId: org.id,
    file: { name: file.name, type: file.type, size: file.size, bytes },
    source: "manual",
    submittedBy: user.id,
    uploadLogId: logRow?.id ?? null,
  });

  if (!jobId) {
    if (logRow) {
      await supabase
        .from("upload_log")
        .update({
          status: "error",
          error: "Could not queue the upload for processing.",
          processed_at: new Date().toISOString(),
        })
        .eq("id", logRow.id);
    }
    return NextResponse.json(
      { error: "Could not queue the upload for processing." },
      { status: 500 }
    );
  }

  // Keep the queue short: drop log/job rows older than 90 days (best-effort)
  // and remove their staging files (failed/no-invoice jobs keep staging for
  // the Reprocess button until it ages out here).
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const admin = createAdminClient();
  await admin.from("upload_log").delete().eq("organization_id", org.id).lt("created_at", cutoff);
  await admin.from("inbound_email_log").delete().eq("organization_id", org.id).lt("created_at", cutoff);
  const { data: oldJobs } = await admin
    .from("ingest_jobs")
    .select("staging_path")
    .eq("organization_id", org.id)
    .lt("created_at", cutoff);
  await admin.from("ingest_jobs").delete().eq("organization_id", org.id).lt("created_at", cutoff);
  const stalePaths = (oldJobs ?? []).map((j) => j.staging_path);
  if (stalePaths.length > 0) {
    await admin.storage.from("invoices").remove(stalePaths);
  }

  revalidateTag(INVOICES_TAG); // a queued upload will become an invoice/split
  return NextResponse.json({ jobId }, { status: 202 });
}
