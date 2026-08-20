import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { SignOutButton } from "@/components/SignOutButton";
import type { Database } from "@/lib/supabase/types";

type OrgRole =
  Database["public"]["Tables"]["organization_members"]["Row"]["role"];

const ROLES: OrgRole[] = ["admin", "approver", "submitter"];
const ROLE_LABELS: Record<OrgRole, string> = {
  admin: "Admin",
  approver: "Approver",
  submitter: "Submitter",
};

const SETTINGS_ERRORS: Record<string, string> = {
  "invite-failed": "Could not invite that user (no Supabase account found).",
  "already-member": "That user is already a member of this organization.",
};

// Invite a teammate: create the auth user (if needed), attach a profile
// row, and add them to the org with a role. Admin-only (RLS).
async function inviteMember(orgId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "approver") as OrgRole;
  if (!email || !ROLES.includes(role)) return;

  const admin = createAdminClient();
  let userId: string | null = null;

  const { data: created } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (created?.user) {
    userId = created.user.id;
  } else {
    // Account already exists — look it up.
    const { data: listed } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    userId =
      listed?.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
  }

  if (!userId) redirect("/settings?error=invite-failed");

  // Ensure a profile row exists (admin client bypasses RLS).
  await admin.from("profiles").upsert(
    { id: userId },
    { onConflict: "id", ignoreDuplicates: true }
  );

  const { error: memberError } = await supabase
    .from("organization_members")
    .insert({ organization_id: orgId, user_id: userId, role });
  if (memberError) redirect("/settings?error=already-member");

  revalidatePath("/settings");
  redirect("/settings");
}

async function updateMemberRole(membershipId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const role = String(formData.get("role") ?? "") as OrgRole;
  if (!ROLES.includes(role)) return;

  await supabase
    .from("organization_members")
    .update({ role })
    .eq("id", membershipId);

  revalidatePath("/settings");
}

async function removeMember(membershipId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Can't remove yourself.
  const { data: member } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("id", membershipId)
    .single();
  if (!member || member.user_id === user.id) return;

  await supabase.from("organization_members").delete().eq("id", membershipId);

  revalidatePath("/settings");
}

async function createProject(orgId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const qboId = String(formData.get("qbo_id") ?? "").trim() || null;

  await supabase.from("projects").insert({
    organization_id: orgId,
    name,
    qbo_id: qboId,
    source: "manual",
  });

  revalidatePath("/settings");
}

async function updateProject(projectId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const qboId = String(formData.get("qbo_id") ?? "").trim() || null;
  const active = formData.get("active") === "on";

  await supabase
    .from("projects")
    .update({ name, qbo_id: qboId, active })
    .eq("id", projectId);

  revalidatePath("/settings");
}

async function deleteProject(projectId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("projects").delete().eq("id", projectId);

  revalidatePath("/settings");
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-xl font-semibold">No organization yet</h1>
        <p className="mt-2 text-slate-600">
          Your account isn&apos;t attached to an organization yet. See the
          README first-org-setup steps.
        </p>
        <div className="mt-4 flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="truncate text-slate-600">
            Signed in as <strong>{user.email}</strong>
          </span>
          <span className="flex-1" />
          <SignOutButton />
        </div>
      </main>
    );
  }

  const isAdmin = org.role === "admin";

  const [{ data: members }, { data: projects }] = await Promise.all([
    supabase
      .from("organization_members")
      .select("id, user_id, role")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("projects")
      .select("*")
      .eq("organization_id", org.id)
      .order("name", { ascending: true }),
  ]);

  // Names from profiles, emails from auth (admin client).
  const userIds = [...new Set((members ?? []).map((m) => m.user_id))];
  const { data: profiles } =
    userIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", userIds)
      : { data: [] };
  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
  );

  const admin = createAdminClient();
  const { data: authUsers } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const emailById = new Map(
    (authUsers?.users ?? []).map((u) => [u.id, u.email ?? null])
  );

  const inputCls =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <div className="text-sm font-semibold">{org.name}</div>
          <div className="mt-0.5 truncate text-xs text-slate-400">
            Settings
          </div>
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

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-8">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">
            {org.name} · you are {ROLE_LABELS[org.role]}
          </p>

          {searchParams.error && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {SETTINGS_ERRORS[searchParams.error] ??
                "That action could not be completed."}
            </div>
          )}

          {/* Members */}
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Members</h2>
            {isAdmin && (
              <form
                action={inviteMember.bind(null, org.id)}
                className="mt-3 flex flex-wrap items-center gap-2"
              >
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="teammate@company.com"
                  className={`${inputCls} min-w-52 flex-1`}
                />
                <select name="role" className={inputCls} defaultValue="approver">
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
                <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  Invite
                </button>
              </form>
            )}

            <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {(members ?? []).map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800">
                      {nameById.get(m.user_id) ?? "Team member"}
                      {m.user_id === user.id && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                          you
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-400">
                      {emailById.get(m.user_id) ?? "—"}
                    </div>
                  </div>
                  {isAdmin ? (
                    <>
                      <form
                        action={updateMemberRole.bind(null, m.id)}
                        className="flex items-center gap-1"
                      >
                        <select
                          name="role"
                          defaultValue={m.role}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                        <button className="rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700">
                          Save
                        </button>
                      </form>
                      {m.user_id !== user.id && (
                        <form action={removeMember.bind(null, m.id)}>
                          <button className="text-xs text-red-500 hover:underline">
                            Remove
                          </button>
                        </form>
                      )}
                    </>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                      {ROLE_LABELS[m.role]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* Projects / customers */}
          <section className="mt-10">
            <h2 className="text-lg font-semibold">Projects / customers</h2>
            <p className="mt-1 text-sm text-slate-500">
              Entered manually for now; the QBO ID field is reserved for when
              QuickBooks sync lands. Invoices can be assigned to a project in
              the Bill panel.
            </p>
            <form
              action={createProject.bind(null, org.id)}
              className="mt-3 flex flex-wrap items-center gap-2"
            >
              <input
                name="name"
                required
                placeholder="Project / customer name"
                className={`${inputCls} min-w-52 flex-1`}
              />
              <input
                name="qbo_id"
                placeholder="QBO ID (optional)"
                className={`${inputCls} w-40`}
              />
              <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Add
              </button>
            </form>

            <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {(projects ?? []).map((p) => (
                <li key={p.id} className="px-4 py-3">
                  <form
                    action={updateProject.bind(null, p.id)}
                    className="flex flex-wrap items-center gap-3"
                  >
                    <input
                      name="name"
                      defaultValue={p.name}
                      className={`${inputCls} min-w-40 flex-1`}
                    />
                    <input
                      name="qbo_id"
                      defaultValue={p.qbo_id ?? ""}
                      placeholder="QBO ID"
                      className={`${inputCls} w-36`}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input
                        name="active"
                        type="checkbox"
                        defaultChecked={p.active}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Active
                    </label>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        p.source === "qbo"
                          ? "bg-blue-50 text-blue-600"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {p.source}
                    </span>
                    <button className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700">
                      Save
                    </button>
                    <form action={deleteProject.bind(null, p.id)}>
                      <button className="text-xs text-red-500 hover:underline">
                        Delete
                      </button>
                    </form>
                  </form>
                </li>
              ))}
              {(projects ?? []).length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-slate-400">
                  No projects yet — add your first project or customer above.
                </li>
              )}
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
