import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { normalizeForMatching } from "@/lib/matching";

// Find-or-create against the real `suppliers` table (migration 0092) —
// the stable identity that duplicate detection, supplier defaults, and
// statement matching key off now, instead of re-normalizing vendor-name
// text at every call site. Not a separate admin UI: suppliers are
// created implicitly the same way supplier_defaults rows already are.
// The first-seen spelling becomes the canonical display name and is
// never silently renamed later. Expects an admin (service-role) client —
// suppliers has no end-user insert policy.
export async function resolveSupplier(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  vendorName: string | null | undefined
): Promise<{ id: string; name: string } | null> {
  const name = vendorName?.trim();
  if (!name) return null;

  const normalized = normalizeForMatching(name);
  const { data: existing } = await supabase
    .from("suppliers")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("name_normalized", normalized)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("suppliers")
    .insert({ organization_id: organizationId, name })
    .select("id, name")
    .single();
  if (created) return created;

  // A concurrent insert for the same normalized name lost the race
  // against the unique constraint — look it up rather than treating this
  // as a real failure.
  if (error?.code === "23505") {
    const { data: retried } = await supabase
      .from("suppliers")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("name_normalized", normalized)
      .maybeSingle();
    if (retried) return retried;
  }
  return null;
}
