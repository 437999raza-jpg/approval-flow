import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { SignOutButton } from "@/components/SignOutButton";

// Phase 2: dashboard-data.ts's requireOrg() redirects here instead of
// rendering this inline, since fetchDashboardListData is also called as a
// client-side queryFn (no JSX to return from there). Re-checks for an org
// on load so a user who joins one elsewhere and comes back isn't stuck.
export default async function DashboardNoOrgPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (org) redirect("/dashboard");

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-xl font-semibold">No organization yet</h1>
      <p className="mt-2 text-slate-600">
        Your account isn&apos;t attached to an organization. Insert a row into
        <code className="mx-1 rounded bg-slate-100 px-1">organizations</code>
        and <code className="mx-1 rounded bg-slate-100 px-1">organization_members</code>
        to get started (see the README).
      </p>
      <div className="mt-4 flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
        <span className="truncate text-slate-600">
          Signed in as <strong>{user.email}</strong>{" "}
          <span className="text-xs text-slate-400">(user id {user.id.slice(0, 8)}…)</span>
        </span>
        <span className="flex-1" />
        <SignOutButton />
      </div>
    </main>
  );
}
