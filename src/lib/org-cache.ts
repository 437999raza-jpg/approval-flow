import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";

// Org-level "static" data caching for the dashboard (and anything else that
// renders the QBO mirrors / member roster). QBO data changes rarely — only
// when an admin presses a sync button — so refetching 2,045 suppliers,
// 220 categories, 175 classes and the tax tables on EVERY navigation is
// wasted work that makes the app feel slower as it grows.
//
// Reads use the admin client inside the cache (org-scoped, RLS-safe: the
// rows are the same ones members can already read), keyed by org id and
// tagged so the sync/member actions can invalidate with revalidateTag().
// A 1-hour safety TTL backs up the explicit invalidation.

export const qboTag = (orgId: string) => `org-qbo-${orgId}`;
export const membersTag = (orgId: string) => `org-members-${orgId}`;

const TTL_SECONDS = 60 * 60; // 1h safety net; syncs invalidate sooner

async function cached<T>(
  key: string[],
  tags: string[],
  fn: () => Promise<T>
): Promise<T> {
  return unstable_cache(fn, key, { tags, revalidate: TTL_SECONDS })();
}

export async function getCachedQboCategories(orgId: string) {
  return cached([`qbo-categories`, orgId], [qboTag(orgId)], async () => {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("qbo_categories")
      .select("name, acct_num")
      .eq("organization_id", orgId)
      .eq("active", true)
      .order("name", { ascending: true })
      .limit(1000);
    return (data ?? []) as { name: string; acct_num: string | null }[];
  });
}

export async function getCachedQboSuppliers(orgId: string) {
  return cached([`qbo-suppliers`, orgId], [qboTag(orgId)], async () => {
    return fetchAllQboSuppliers(createAdminClient(), orgId);
  });
}

export async function getCachedQboClasses(orgId: string) {
  return cached([`qbo-classes`, orgId], [qboTag(orgId)], async () => {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("qbo_classes")
      .select("name")
      .eq("organization_id", orgId)
      .eq("active", true)
      .order("name", { ascending: true })
      .limit(1000);
    return (data ?? []) as { name: string }[];
  });
}

export async function getCachedQboTaxRates(orgId: string) {
  return cached([`qbo-tax-rates`, orgId], [qboTag(orgId)], async () => {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("qbo_tax_rates")
      .select("name, rate_value")
      .eq("organization_id", orgId)
      .order("rate_value", { ascending: true });
    return (data ?? []) as { name: string; rate_value: number | null }[];
  });
}

export async function getCachedQboTaxCodes(orgId: string) {
  return cached([`qbo-tax-codes`, orgId], [qboTag(orgId)], async () => {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("qbo_tax_codes")
      .select("qbo_tax_code_id, name, rate_value")
      .eq("organization_id", orgId)
      .order("name", { ascending: true });
    return (data ?? []) as {
      qbo_tax_code_id: string;
      name: string;
      rate_value: number | null;
    }[];
  });
}

export async function getCachedMemberRoster(orgId: string) {
  return cached([`member-roster`, orgId], [membersTag(orgId)], async () => {
    const supabase = createAdminClient();
    const { data: rows } = await supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", orgId);
    const memberUserIds = [
      ...new Set((rows ?? []).map((m) => m.user_id)),
    ];
    const { data: profileRows } =
      memberUserIds.length > 0
        ? await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", memberUserIds)
        : { data: [] };
    return {
      memberUserIds,
      profileRows: (profileRows ?? []) as {
        id: string;
        full_name: string | null;
      }[],
    };
  });
}
