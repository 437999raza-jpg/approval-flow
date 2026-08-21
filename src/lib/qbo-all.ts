import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// PostgREST (Supabase) caps every response at 1000 rows regardless of
// .limit(), so fetching the full supplier list (2,045+) requires paging
// with .range(). Returns all rows merged, ordered by name.
// Authored by Araza.
export async function fetchAllQboSuppliers(
  supabase: SupabaseClient<Database>,
  organizationId: string
): Promise<{ id: string; name: string }[]> {
  const all: { id: string; name: string }[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("qbo_suppliers")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("active", true)
      .order("name", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) break;
    all.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
    from += pageSize;
  }
  return all;
}
