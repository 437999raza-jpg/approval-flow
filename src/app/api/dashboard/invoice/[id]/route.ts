import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { fetchInvoiceDetail } from "@/lib/dashboard-data";

// A plain Route Handler, not a Server Action, on purpose: DashboardClient
// calls this at high volume (every invoice row that scrolls into view,
// via IntersectionObserver-driven prefetch). Every "use server" call —
// mutation or pure read alike — makes Next's client router refetch and
// swap in fresh RSC for whatever route it still thinks is mounted
// (confirmed by reading server-action-reducer.js/handle-mutable.js in
// next/dist). Since this Dashboard manages its own URL via
// window.history.replaceState and never calls Next's router, that
// "current route" the RSC swap targets is permanently stuck at the
// server's last real Next navigation (bare /dashboard) — so a
// high-frequency stream of Server Action calls remounts DashboardClient
// and wipes its state mid-session. A Route Handler returns plain JSON
// over fetch() and never enters that machinery.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const org = await getCurrentOrg(supabase);
  if (!org) return NextResponse.json({ error: "no organization" }, { status: 401 });

  const detail = await fetchInvoiceDetail(params.id);
  return NextResponse.json(detail);
}
