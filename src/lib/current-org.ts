import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// MVP: a user belongs to one org, so "current org" is just their first
// membership. Swap for a real org-switcher once multi-org membership matters.
export async function getCurrentOrg(supabase: SupabaseClient<Database>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) return null;

  const { data: organization } = await supabase
    .from("organizations")
    .select("id, name, slug, inbound_email_token, default_tax_rate")
    .eq("id", membership.organization_id)
    .single();

  if (!organization) return null;

  return { ...organization, role: membership.role };
}
