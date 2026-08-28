import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { postSupportMessage } from "@/lib/support-actions";
import { SignOutButton } from "@/components/SignOutButton";
import { SupportComposer } from "@/components/SupportComposer";
import { SupportChatPoller } from "@/components/SupportChatPoller";
import { SupportChatScroller } from "@/components/SupportChatScroller";
import { LocalTime } from "@/components/LocalTime";

// One continuous chat thread per organization — any member can read/post
// (RLS: is_org_member), no role restriction, since reaching support
// shouldn't need admin permissions. Platform admins reach it the exact
// same way regular members do: by being an organization_members row on
// that org (already how admin-created orgs work). Authored by Araza.
export default async function SupportPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");

  const { data: messages } = await supabase
    .from("support_messages")
    .select("*")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: true });

  const authorIds = [
    ...new Set((messages ?? []).map((m) => m.author_id).filter((id): id is string => !!id)),
  ];
  const [{ data: profiles }, { data: authUsers }] = await Promise.all([
    authorIds.length > 0
      ? supabase.from("profiles").select("id, full_name").in("id", authorIds)
      : Promise.resolve({ data: [] }),
    // Only used to label which authors are platform-support staff — a
    // small badge so a customer can tell "the vendor replied" from their
    // own teammates in the same thread.
    authorIds.length > 0
      ? createAdminClient().auth.admin.listUsers({ page: 1, perPage: 1000 })
      : Promise.resolve({ data: { users: [] } }),
  ]);
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"]));
  const emailById = new Map(
    (authUsers?.users ?? []).map((u) => [u.id, u.email ?? null])
  );

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <div className="text-sm font-semibold">{org.name}</div>
          <div className="mt-0.5 truncate text-xs text-slate-400">Support</div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          <Link
            href="/dashboard"
            className="block rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            ← Back to dashboard
          </Link>
        </nav>
        <div className="flex items-center justify-between border-t border-slate-200 p-4">
          <span className="truncate text-xs text-slate-500">{user.email}</span>
          <SignOutButton />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <SupportChatPoller />
        <div className="flex-none border-b border-slate-200 bg-white px-6 py-4">
          <h1 className="text-lg font-semibold">Chat with Support</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            Anyone at {org.name} can see and reply here.
          </p>
        </div>

        <SupportChatScroller messageCount={(messages ?? []).length}>
          <div className="mx-auto max-w-2xl space-y-3 p-6">
            {(messages ?? []).length === 0 ? (
              <p className="text-center text-sm text-slate-400">
                No messages yet — say hello.
              </p>
            ) : (
              (messages ?? []).map((m) => {
                const isMe = m.author_id === user.id;
                const email = m.author_id ? emailById.get(m.author_id) : null;
                const isSupport = isPlatformAdmin(email);
                return (
                  <div
                    key={m.id}
                    className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                  >
                    <div className={`max-w-[75%] ${isMe ? "items-end" : "items-start"} flex flex-col`}>
                      <div className="mb-0.5 flex items-center gap-1.5 px-1 text-[11px] text-slate-400">
                        <span className="font-medium text-slate-500">
                          {m.author_id ? nameById.get(m.author_id) ?? "Team member" : "Someone"}
                        </span>
                        {isSupport && (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            Support
                          </span>
                        )}
                        <LocalTime iso={m.created_at} />
                      </div>
                      <div
                        className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                          isMe
                            ? "bg-blue-600 text-white"
                            : isSupport
                              ? "bg-emerald-50 text-slate-800"
                              : "bg-white text-slate-800 shadow-sm"
                        }`}
                      >
                        {m.body}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </SupportChatScroller>

        <SupportComposer postMessage={postSupportMessage.bind(null, org.id)} />
      </main>
    </div>
  );
}
