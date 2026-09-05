import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { normalizeForMatching } from "@/lib/matching";

// Find-or-create against the real `suppliers` table (migration 0092) —
// the stable identity that duplicate detection, supplier defaults, and
// statement matching key off now, instead of re-normalizing vendor-name
// text at every call site. Not a separate admin UI: suppliers are
// created implicitly the same way supplier_defaults rows already are.
// The first-seen spelling becomes the canonical display name and is
// never silently renamed later. Works under either an admin client or a
// plain session client — the "suppliers: members can insert" RLS policy
// (migration 0092) already covers non-auditor org members.
//
// qboVendorId links this supplier to its real QuickBooks vendor id when
// the caller already knows it (a confirmed match, or iterating QBO's own
// vendor list directly). It only ever fills in a missing link — an
// existing row's qbo_vendor_id is never overwritten, so a call site with
// no QBO info (e.g. re-extraction) can't erase a link ingestion already
// established.
export async function resolveSupplier(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  vendorName: string | null | undefined,
  qboVendorId?: string | null
): Promise<{ id: string; name: string } | null> {
  const name = vendorName?.trim();
  if (!name) return null;

  const normalized = normalizeForMatching(name);
  const { data: existing } = await supabase
    .from("suppliers")
    .select("id, name, qbo_vendor_id")
    .eq("organization_id", organizationId)
    .eq("name_normalized", normalized)
    .maybeSingle();
  if (existing) {
    if (qboVendorId && !existing.qbo_vendor_id) {
      await supabase.from("suppliers").update({ qbo_vendor_id: qboVendorId }).eq("id", existing.id);
    }
    return { id: existing.id, name: existing.name };
  }

  const { data: created, error } = await supabase
    .from("suppliers")
    .insert({ organization_id: organizationId, name, qbo_vendor_id: qboVendorId ?? null })
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

// PostgREST (Supabase) caps every response at 1000 rows regardless of
// .limit(), so any bulk read of the full suppliers table needs to page
// with .range() — an org can have well over 1000 (this one has 2,048+).
// A plain unpaginated .select() silently returns an arbitrary ~1000-row
// slice with no error, which is exactly what caused the QBO bill import
// to report real, long-standing vendors as "not in Flow's supplier list
// yet": the match table it built only ever held a fraction of the org's
// suppliers. Same pattern as fetchAllQboSuppliers (qbo-all.ts) for the
// separate qbo_suppliers mirror table. Authored by Araza.
export async function fetchAllSuppliers(
  supabase: SupabaseClient<Database>,
  organizationId: string
): Promise<{ id: string; name: string; qbo_vendor_id: string | null; email: string | null }[]> {
  const all: { id: string; name: string; qbo_vendor_id: string | null; email: string | null }[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("suppliers")
      .select("id, name, qbo_vendor_id, email")
      .eq("organization_id", organizationId)
      .range(from, from + pageSize - 1);
    if (error) break;
    all.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
    from += pageSize;
  }
  return all;
}
