import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Flow's usage billing: one usage_events row per document the org accepted
// into the pipeline (an inbound-email attachment or a manual upload). The
// SaaS charges the client per document processed (default $0.15 USD, see
// organizations.usage_rate_usd), tracked here and shown on the Billing
// page. Best-effort — a failed record must never break ingestion.
// Authored by Araza.

export async function recordUsageEvent(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  documentName: string,
  source: "email" | "manual"
): Promise<void> {
  try {
    await supabase.from("usage_events").insert({
      organization_id: organizationId,
      document_name: documentName.slice(0, 300),
      source,
    });
  } catch (err) {
    console.error("recordUsageEvent failed:", err);
  }
}
