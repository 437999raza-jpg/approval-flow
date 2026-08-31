import { cache } from "react";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// ACTIVE_ORG_COOKIE lets a user who belongs to more than one org (currently
// only the platform admin, who's added as a support member of every org —
// see createOrganizationAction/joinOrganizationAction in admin-actions.ts)
// pick which one they're viewing. Everyone else has exactly one membership,
// so this never comes into play for them — same effective behavior as the
// old "just pick their first membership" MVP logic.
//
// cache()'d: a shared layout and the page it wraps both call this
// independently, and without memoizing, that's the auth check plus two
// more round trips duplicated on every single navigation. Dedupes
// correctly because createClient() (lib/supabase/server.ts) is cache()'d
// too, so both callers pass the same client instance — cache()'s key.
export const getCurrentOrg = cache(async function getCurrentOrg(
  supabase: SupabaseClient<Database>
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  type Membership = Pick<
    Database["public"]["Tables"]["organization_members"]["Row"],
    "organization_id" | "role"
  >;

  const activeOrgId = cookies().get("active_org_id")?.value;
  let membership: Membership | null = null;

  if (activeOrgId) {
    const { data } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .eq("organization_id", activeOrgId)
      .maybeSingle();
    membership = data;
  }

  if (!membership) {
    const { data } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    membership = data;
  }

  if (!membership) return null;

  const { data: organization } = await supabase
    .from("organizations")
    .select("id, name, slug, inbound_email_token, inbound_email_local, default_tax_rate, default_tax_code_id")
    .eq("id", membership.organization_id)
    .single();

  if (!organization) return null;

  return { ...organization, role: membership.role };
});
