import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { switchOrgAction } from "@/lib/admin-actions";
import { AppSidebar } from "@/components/AppSidebar";
import { QueryProvider } from "@/components/QueryProvider";

// Shared shell for every non-Dashboard authenticated page (Settings,
// Workflows, Reports, Billing, Statements, Queue, Notifications, Add
// invoice, pending-splits review). Before this, each of those pages
// either had no sidebar at all or hand-rolled its own — meaning
// navigating between them fully remounted the sidebar and re-fetched
// org/user data every time. One layout means the sidebar persists across
// navigations within this group, and getCurrentOrg/createClient's own
// cache() (see those files) means this and the page it wraps don't
// double up on the same auth/org round trip.
//
// The Dashboard route is deliberately NOT in this group — its two-pane
// list/detail layout and per-view invoice nav list don't fit a plain
// "sidebar + single content area" shell, so it keeps rendering its own
// AppSidebar directly (still benefiting from the same caching).
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  // No org yet is a rare, first-ever-user edge case — Dashboard already
  // has the canonical "no organization yet" explanation screen, so route
  // there instead of duplicating that message here.
  if (!org) redirect("/dashboard");

  const [{ data: myMemberships }, pendingSplitsRes, unreadNotificationsRes] =
    await Promise.all([
      supabase.from("organization_members").select("organization_id").eq("user_id", user.id),
      supabase
        .from("pending_invoice_splits")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .eq("status", "pending"),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("read", false),
    ]);

  const myOrgIds = (myMemberships ?? []).map((m) => m.organization_id);
  let myOrgs: { id: string; name: string }[] = [];
  if (myOrgIds.length > 1) {
    const { data } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", myOrgIds)
      .order("name");
    myOrgs = data ?? [];
  }

  return (
    <QueryProvider>
      <div className="flex h-screen bg-slate-50 text-slate-900">
        <AppSidebar
          org={org}
          user={user}
          myOrgs={myOrgs}
          switchOrgAction={switchOrgAction}
          isPlatformAdmin={isPlatformAdmin(user.email)}
          counts={{
            mentions: unreadNotificationsRes.count ?? 0,
            pendingSplits: pendingSplitsRes.count ?? 0,
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {children}
        </div>
      </div>
    </QueryProvider>
  );
}
