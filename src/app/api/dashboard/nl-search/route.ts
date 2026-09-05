import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { parseNaturalLanguageSearch } from "@/lib/nl-search";

// Backs SearchInput's sentence-detection path: translates a plain-English
// query into the same DocumentSearchFilters shape the "Filters" modal
// produces. Authored by Araza.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await getCurrentOrg(supabase);
  if (!org) return NextResponse.json({ error: "no organization" }, { status: 400 });

  const { query } = (await request.json()) as { query?: string };
  const text = String(query ?? "").trim();
  if (!text) return NextResponse.json({ filters: null });

  const [{ data: invoices }, { data: projects }, { data: members }] = await Promise.all([
    supabase.from("invoices").select("vendor_name, supplier_id").eq("organization_id", org.id),
    supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", org.id)
      .eq("active", true),
    supabase.from("organization_members").select("user_id").eq("organization_id", org.id),
  ]);

  // Keyed by supplier_id (the real Supplier entity), not vendor_name —
  // that's the id the "Filters" modal's own Supplier multi-select and
  // the actual invoice query (advanced.supplier, dashboard-computations.ts)
  // both match against. A vendor with no supplier_id yet (pre-dates the
  // Supplier entity backfill, or never resolved) can't be searched by
  // name here — it's just not offered as a candidate, rather than
  // resolving to a value nothing downstream can ever match.
  const vendorNameById = new Map<string, string>();
  for (const i of invoices ?? []) {
    if (i.supplier_id && i.vendor_name && !vendorNameById.has(i.supplier_id)) {
      vendorNameById.set(i.supplier_id, i.vendor_name);
    }
  }
  const vendors = [...vendorNameById.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const memberIds = (members ?? []).map((m) => m.user_id);
  const { data: profiles } =
    memberIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", memberIds)
      : { data: [] as { id: string; full_name: string | null }[] };
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"]));
  const memberContext = memberIds.map((id) => ({ id, name: nameById.get(id) ?? "Team member" }));

  const filters = await parseNaturalLanguageSearch(
    text,
    {
      vendors,
      projects: (projects ?? []).map((p) => ({ id: p.id, name: p.name })),
      members: memberContext,
    },
    org.id
  );

  return NextResponse.json({ filters });
}
