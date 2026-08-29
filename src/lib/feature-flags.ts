import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Feature flags: a global default per key, with optional per-org overrides
// (managed from the separate Ufirst Ops app — this repo only reads them).
// An org-specific row always wins over the global default; an unknown key
// defaults to false rather than throwing, so a call site can check a flag
// that hasn't been created in the DB yet without erroring.
// Authored by Araza.
export async function isFeatureEnabled(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  key: string
): Promise<boolean> {
  const { data: override } = await supabase
    .from("feature_flag_overrides")
    .select("enabled")
    .eq("flag_key", key)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (override) return override.enabled;

  const { data: flag } = await supabase
    .from("feature_flags")
    .select("global_enabled")
    .eq("key", key)
    .maybeSingle();
  return flag?.global_enabled ?? false;
}
