// Vercel Hobby caps configurable duration at 60s — the
// OpenRouter extraction call can take 20-60s.
export const maxDuration = 60;

// Phase 2: this route used to server-render the entire list+detail view on
// every navigation (invoice click, filter change, sidebar view switch) —
// the actual slow path this rewrite targets. It now only does the initial
// data fetch for the list; DashboardClient owns the list/detail interaction
// entirely client-side (React Query cache, no server round-trip per click).
// The [[...id]]/search-params catch-all stays so a hard refresh or a
// deep/email link to /dashboard/<id>?... still resolves to a real route —
// DashboardClient reads the id and query string off window.location itself
// on mount, so no params are threaded through here.
import { fetchDashboardListData } from "@/lib/dashboard-data";
import { DashboardClient } from "@/components/dashboard/DashboardClient";
import { QueryProvider } from "@/components/QueryProvider";

export default async function DashboardPage() {
  const initialListData = await fetchDashboardListData();
  return (
    <QueryProvider>
      <DashboardClient initialListData={initialListData} />
    </QueryProvider>
  );
}
