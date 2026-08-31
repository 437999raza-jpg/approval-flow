import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";
import type { Database } from "@/lib/supabase/types";

type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];

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
// Global tag (not per-org): ANY invoice mutation invalidates the cached
// list. Over-invalidation across orgs is harmless — just a refetch — and it
// keeps every mutating action one line instead of needing org lookups.
export const INVOICES_TAG = "invoices-list";

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

// The dashboard's invoice list + the two org-wide lookups derived from it
// (approved-pairs for badges, line-item class/category for filters and
// matching). Invalidated by every invoice-mutating action via INVOICES_TAG,
// plus a 10-minute safety TTL.
async function fetchInvoiceListDirect(orgId: string) {
  const supabase = createAdminClient();
  const { data: invoices } = await supabase
    .from("invoices")
    .select("*")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false });
  const invoiceIds = (invoices ?? []).map((i) => i.id);
  const { data: approvedPairs } =
    invoiceIds.length > 0
      ? await supabase
          .from("invoice_approvals")
          .select("invoice_id, approver_id")
          .in("invoice_id", invoiceIds)
          .eq("decision", "approved")
      : { data: [] };
  const { data: lineItemRows } =
    invoiceIds.length > 0
      ? await supabase
          .from("invoice_line_items")
          .select("invoice_id, class, category, project_id")
          .in("invoice_id", invoiceIds)
      : { data: [] };
  return {
    invoices: (invoices ?? []) as InvoiceRow[],
    approvedPairs: (approvedPairs ?? []) as {
      invoice_id: string;
      approver_id: string;
    }[],
    lineItemRows: (lineItemRows ?? []) as {
      invoice_id: string;
      class: string | null;
      category: string | null;
      project_id: string | null;
    }[],
  };
}

export async function getCachedInvoiceList(orgId: string) {
  return cached([`invoice-list`, orgId], [INVOICES_TAG], () => fetchInvoiceListDirect(orgId));
}

// Uncached variant for the client-driven Dashboard (dashboard-data.ts):
// that page's own TanStack Query cache (30s staleTime) already avoids
// hammering the database, and it only ever re-calls this after an
// explicit mutation invalidates its query key. Layering unstable_cache's
// revalidateTag underneath that turned out to race — two mutations on the
// same invoice in quick succession (e.g. reassign then override status)
// could leave this tag's cache entry stuck serving the FIRST mutation's
// snapshot indefinitely, invisible to the acting user until a hard
// reload. Reading straight from the database sidesteps that entirely.
export async function getInvoiceListUncached(orgId: string) {
  return fetchInvoiceListDirect(orgId);
}
