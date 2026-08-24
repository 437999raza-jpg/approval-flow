import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { SignOutButton } from "@/components/SignOutButton";
import { disconnectQbo, refreshQboData, saveDefaultTaxRate, syncQboTaxes, syncQboClasses, syncQboCategories, syncQboSuppliers, syncQboProjects } from "@/lib/dashboard-actions";
import { qboEnv } from "@/lib/qbo";
import { Avatar } from "@/components/Avatar";
import { AvatarUploadForm } from "@/components/AvatarUploadForm";
import { AddUsersModal } from "@/components/AddUsersModal";
import { SearchInput } from "@/components/SearchInput";
import { InlineSelectSave } from "@/components/InlineSelectSave";
import { InlineTextSave } from "@/components/InlineTextSave";
import { SubmitButton } from "@/components/SubmitButton";
import { DefaultTaxRateForm } from "@/components/DefaultTaxRateForm";
import type { Database } from "@/lib/supabase/types";

type OrgRole =
  Database["public"]["Tables"]["organization_members"]["Row"]["role"];

const ROLES: OrgRole[] = ["user", "auditor", "admin"];
const ROLE_LABELS: Record<OrgRole, string> = {
  user: "User",
  auditor: "Auditor",
  admin: "Admin",
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
  const fullName = String(formData.get("full_name") ?? "").trim() || null;
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

  // Ensure a profile row exists (admin client bypasses RLS). Only sets the
  // name on first creation — never overwrites a name the user set themselves.
  await admin.from("profiles").upsert(
    { id: userId, full_name: fullName },
    { onConflict: "id", ignoreDuplicates: true }
  );

  const { error: memberError } = await supabase
    .from("organization_members")
    .insert({ organization_id: orgId, user_id: userId, role });
  if (memberError) redirect("/settings?error=already-member");

  revalidatePath("/settings");
  redirect("/settings");
}

// Update the signed-in user's own display name (any member may edit this).
async function updateProfileName(formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const fullName = String(formData.get("full_name") ?? "").trim();
  await supabase
    .from("profiles")
    .update({ full_name: fullName || null })
    .eq("id", user.id);

  revalidatePath("/settings");
  revalidatePath("/dashboard");
}

// Upload the signed-in user's own profile photo to the "avatars" bucket
// (migration 0016) at {user_id}/avatar.{ext}, then point profiles.avatar_url
// at its public URL. upsert:true so re-uploading replaces the old photo.
async function uploadAvatar(formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > 5 * 1024 * 1024) return; // 5MB
  const extByType: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const ext = extByType[file.type];
  if (!ext) return;

  const path = `${user.id}/avatar.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(path, file, { contentType: file.type, upsert: true });
  if (uploadError) return;

  const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
  await supabase
    .from("profiles")
    .update({ avatar_url: `${pub.publicUrl}?v=${Date.now()}` })
    .eq("id", user.id);

  revalidatePath("/settings");
  revalidatePath("/dashboard");
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
  searchParams: { error?: string; q?: string; qbo?: string; count?: string; taxdefault?: string; rate?: string };
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

  // QBO connection (RLS: admins only — everyone else sees nothing).
  const { data: qboConnection } = await supabase
    .from("qbo_connections")
    .select("realm_id, company_name, connected_at")
    .eq("organization_id", org.id)
    .maybeSingle();

  // Tax codes with resolved rates pulled from QBO (read-only mirror) — the
  // codes are what the bill's Tax field offers, exactly like Dext. Only
  // codes with a usable rate are listed (H 13%, M&E 13%, Out of Scope 0%).
  const { data: qboTaxCodes } = await supabase
    .from("qbo_tax_codes")
    .select("id, name, rate_value")
    .eq("organization_id", org.id)
    .not("rate_value", "is", null)
    .order("name", { ascending: true })
    .limit(50);

  // Default-tax-rate choices = the distinct synced rates, sorted.
  const defaultTaxRates = [
    ...new Set(
      (qboTaxCodes ?? [])
        .map((c) => c.rate_value)
        .filter((r): r is number => r != null)
    ),
  ].sort((a, b) => a - b);

  // Per-section sync log (migration 0049): when each QBO mirror was last
  // synced, so sections can show "N on File. Last synced on <time>".
  const { data: qboSyncLog } = await supabase
    .from("qbo_sync_log")
    .select("section, synced_at")
    .eq("organization_id", org.id);
  const lastSyncBySection = new Map(
    (qboSyncLog ?? []).map((r) => [r.section, r.synced_at])
  );
  const classesLastSync = lastSyncBySection.get("classes");
  const categoriesLastSync = lastSyncBySection.get("categories");
  const suppliersLastSync = lastSyncBySection.get("suppliers");
  const projectsLastSync = lastSyncBySection.get("projects");

  // Exact "on file" counts — PostgREST caps row responses at 1000 rows, so
  // use head + count=exact rather than fetching the lists.
  const [
    { count: classesCount },
    { count: categoriesCount },
    { count: suppliersCount },
    { count: projectsCount },
  ] = await Promise.all([
    supabase
      .from("qbo_classes")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id),
    supabase
      .from("qbo_categories")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id),
    supabase
      .from("qbo_suppliers")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id),
    supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .eq("source", "qbo"),
  ]);

  // ONLY the items that are NEW in the most recent sync run get listed in
  // each section (first_seen_at >= that run's log timestamp). Blank when
  // nothing new — the section never synced shows nothing either.
  const newClasses = classesLastSync
    ? (await supabase
        .from("qbo_classes")
        .select("id, name")
        .eq("organization_id", org.id)
        .gte("first_seen_at", classesLastSync)
        .order("name", { ascending: true })
        .limit(100)).data ?? []
    : [];
  const newCategories = categoriesLastSync
    ? (await supabase
        .from("qbo_categories")
        .select("id, name, acct_num, account_type, account_sub_type")
        .eq("organization_id", org.id)
        .gte("first_seen_at", categoriesLastSync)
        .order("name", { ascending: true })
        .limit(100)).data ?? []
    : [];
  const newSuppliers = suppliersLastSync
    ? (await supabase
        .from("qbo_suppliers")
        .select("id, name")
        .eq("organization_id", org.id)
        .gte("first_seen_at", suppliersLastSync)
        .order("name", { ascending: true })
        .limit(100)).data ?? []
    : [];
  const newProjects = projectsLastSync
    ? (await supabase
        .from("projects")
        .select("id, name")
        .eq("organization_id", org.id)
        .eq("source", "qbo")
        .gte("first_seen_at", projectsLastSync)
        .order("name", { ascending: true })
        .limit(100)).data ?? []
    : [];

  // Billing & usage: this month's invoice counts (org-wide, admin view).
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: monthInvoices } = await supabase
    .from("invoices")
    .select("status")
    .eq("organization_id", org.id)
    .gte("created_at", monthStart.toISOString());
  const usageByStatus = new Map<string, number>();
  for (const inv of monthInvoices ?? []) {
    usageByStatus.set(inv.status, (usageByStatus.get(inv.status) ?? 0) + 1);
  }
  const usageTotal = (monthInvoices ?? []).length;

  const rate = Number(process.env.BILLING_RATE_PER_INVOICE || 5);
  const suggestedCharge = usageTotal * rate;

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

  // Names + photos from profiles, emails + 2FA status from auth (admin client).
  const userIds = [...new Set((members ?? []).map((m) => m.user_id))];
  const { data: profiles } =
    userIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, full_name, avatar_url")
          .in("id", userIds)
      : { data: [] };
  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
  );
  const avatarById = new Map((profiles ?? []).map((p) => [p.id, p.avatar_url]));

  const admin = createAdminClient();
  const { data: authUsers } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const emailById = new Map(
    (authUsers?.users ?? []).map((u) => [u.id, u.email ?? null])
  );
  // Real MFA status, not a placeholder — GoTrue returns each user's enrolled
  // factors on listUsers().
  const mfaEnabledById = new Map(
    (authUsers?.users ?? []).map((u) => [
      u.id,
      Array.isArray(u.factors) && u.factors.some((f) => f.status === "verified"),
    ])
  );

  const q = searchParams.q?.trim().toLowerCase() ?? "";
  const visibleMembers = (members ?? []).filter((m) => {
    if (!q) return true;
    const name = nameById.get(m.user_id)?.toLowerCase() ?? "";
    const email = emailById.get(m.user_id)?.toLowerCase() ?? "";
    return name.includes(q) || email.includes(q);
  });

  const myName = nameById.get(user.id) ?? "";
  const myAvatar = avatarById.get(user.id) ?? null;

  const inputCls =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

  // "Last synced on Feb 21, 2026, 3:42 PM" style timestamps for the QBO
  // mirror sections.
  const fmtSync = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

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
        <div className="mx-auto max-w-6xl p-8">
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

          {/* My profile */}
          <section className="mt-8">
            <h2 className="text-lg font-semibold">My profile</h2>
            <div className="mt-3 flex items-center gap-4 rounded-lg border border-slate-200 bg-white p-4">
              <Avatar name={myName || user.email || "?"} photoUrl={myAvatar} size="lg" />
              <div className="flex-1">
                <InlineTextSave
                  name="full_name"
                  defaultValue={myName}
                  placeholder="Your name"
                  action={updateProfileName}
                />
                <div className="mt-2">
                  <AvatarUploadForm uploadAction={uploadAvatar} />
                </div>
              </div>
            </div>
          </section>

          {/* Integrations */}
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Integrations</h2>
            <p className="mt-1 text-sm text-slate-500">
              Connect external apps here — connection details stay out of the
              Bill panel, which only shows sync status and links.
            </p>
            {searchParams.qbo === "connected" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Connected to QuickBooks successfully.
              </div>
            )}
            {searchParams.qbo === "categories_synced" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Imported {searchParams.count ?? 0} categor{Number(searchParams.count) === 1 ? "y" : "ies"} from QuickBooks (read-only).
              </div>
            )}
            {searchParams.qbo === "tax_synced" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Synced tax rates from QuickBooks (read-only).
              </div>
            )}
            {searchParams.qbo === "classes_synced" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Synced {searchParams.count ?? 0} class{Number(searchParams.count) === 1 ? "" : "es"} from QuickBooks (read-only).
              </div>
            )}
            {searchParams.qbo === "refresh_done" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Refreshed {searchParams.count ?? 0} items from QuickBooks (read-only).
              </div>
            )}
            {searchParams.qbo === "suppliers_synced" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Synced {searchParams.count ?? 0} suppliers from QuickBooks (read-only).
              </div>
            )}
            {searchParams.qbo === "projects_synced" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Synced {searchParams.count ?? 0} projects from QuickBooks (read-only).
              </div>
            )}
            {searchParams.taxdefault === "saved" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Default tax rate saved: {searchParams.rate}%.
              </div>
            )}
            {searchParams.taxdefault === "cleared" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Default tax rate cleared — new invoices will use extraction
                or supplier rules.
              </div>
            )}
            {searchParams.taxdefault === "error" && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Could not save the default tax rate.
              </div>
            )}
            {searchParams.qbo === "error" && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                The QuickBooks connection failed. If you cancelled the
                authorization, just try again.
              </div>
            )}
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-400">
                QuickBooks Online
              </div>
              <div className="mt-2">
              {qboConnection ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-slate-700">
                    Connected to{" "}
                    <strong>{qboConnection.company_name ?? "QuickBooks"}</strong>
                  </span>
                  <span className="text-xs text-slate-400">
                    realm {qboConnection.realm_id}
                  </span>
                  <span className="flex-1" />
                  <a
                    href="/api/qbo/auth"
                    className="rounded-md border border-blue-600 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
                  >
                    Reconnect
                  </a>
                  <form action={disconnectQbo}>
                    <SubmitButton className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                      Disconnect
                    </SubmitButton>
                  </form>
                </div>
              ) : isAdmin ? (
                qboEnv() ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-slate-600">
                      Connect this org to a QuickBooks company to pull
                      categories (Chart of Accounts) into the app. Read-only —
                      nothing is written to QuickBooks.
                    </span>
                    <span className="flex-1" />
                    <a
                      href="/api/qbo/auth"
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Connect QuickBooks
                    </a>
                  </div>
                ) : (
                  <p className="text-slate-500">
                    QuickBooks is not configured on this server. Set{" "}
                    <code className="rounded bg-slate-100 px-1">QBO_CLIENT_ID</code>,{" "}
                    <code className="rounded bg-slate-100 px-1">QBO_CLIENT_SECRET</code>{" "}
                    and{" "}
                    <code className="rounded bg-slate-100 px-1">QBO_REDIRECT_URI</code>{" "}
                    in <code className="rounded bg-slate-100 px-1">.env.local</code>{" "}
                    (and register the redirect URI in your Intuit app).
                  </p>
                )
              ) : (
                <p className="text-slate-500">
                  QuickBooks sync is managed by the org admin.
                </p>
              )}
              </div>

              {/* Data from QuickBooks — read-only pulls */}
              <div className="mt-3 border-t border-slate-100 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400">
                    Data from QuickBooks
                  </div>
                  <span className="flex-1" />
                  {isAdmin && qboConnection && (
                    <form action={refreshQboData}>
                      <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                        Refresh data
                      </SubmitButton>
                    </form>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  QuickBooks is the source of truth. These lists are pulled
                  read-only — when you add or update tax rates, classes,
                  categories, or suppliers in QuickBooks, refresh to bring
                  the changes into Flow. Nothing is ever written to
                  QuickBooks from Flow.
                </p>

                {/* Tax codes (what the bill's Tax field offers) */}
                <div className="mt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      Tax
                    </span>
                    {isAdmin && (
                      <form action={syncQboTaxes}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync taxes from QuickBooks
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    These are the codes the bill&apos;s Tax field offers —
                    type &quot;h&quot; for HST, like Dext. Only active QBO
                    codes appear.
                  </p>
                  {qboTaxCodes && qboTaxCodes.length > 0 ? (
                    <ul className="mt-2 space-y-0.5">
                      {(qboTaxCodes ?? []).map((c) => (
                        <li key={c.id} className="text-sm text-slate-700">
                          {c.name} ({c.rate_value}%)
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-slate-400">
                      No tax data synced yet.
                    </p>
                  )}
                </div>

                {/* Default tax rate for new invoices */}
                {isAdmin && qboTaxCodes && qboTaxCodes.length > 0 && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <div className="text-xs font-bold uppercase tracking-wide text-slate-400">
                      Default tax rate for new invoices
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Applied to every incoming invoice when the supplier has
                      no rule of their own. Choose one of the synced rates.
                    </p>
                    <DefaultTaxRateForm
                      currentRate={org.default_tax_rate}
                      rates={defaultTaxRates}
                      action={saveDefaultTaxRate}
                    />
                  </div>
                )}

                {/* Classes */}
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      Classes
                    </span>
                    {isAdmin && (
                      <form action={syncQboClasses}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync classes from QuickBooks
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    New classes added in QuickBooks show up here after a
                    sync.
                  </p>
                  <div className="mt-1 text-xs text-slate-400">
                    {classesCount != null
                      ? `${classesCount} class${classesCount === 1 ? "" : "es"} on File. `
                      : ""}
                    {classesLastSync ? (
                      <>Last synced on {fmtSync(classesLastSync)}.</>
                    ) : (
                      <>Not synced yet.</>
                    )}
                  </div>
                  {newClasses.length > 0 && (
                    <div className="mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Newly synced
                      </div>
                      <ul className="mt-0.5 flex max-h-48 flex-wrap gap-x-4 gap-y-0.5 overflow-y-auto">
                        {newClasses.map((c) => (
                          <li key={c.id} className="w-40 text-sm text-slate-700">
                            {c.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Projects */}
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      Projects
                    </span>
                    {isAdmin && (
                      <form action={syncQboProjects}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync projects from QuickBooks
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Read-only from QuickBooks — these are the QBO projects
                    (customers with IsProject=true). Regular customers are
                    not imported.
                  </p>
                  <div className="mt-1 text-xs text-slate-400">
                    {projectsCount != null
                      ? `${projectsCount} project${projectsCount === 1 ? "" : "s"} on File. `
                      : ""}
                    {projectsLastSync ? (
                      <>Last synced on {fmtSync(projectsLastSync)}.</>
                    ) : (
                      <>Not synced yet.</>
                    )}
                  </div>
                  {newProjects.length > 0 && (
                    <div className="mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Newly synced
                      </div>
                      <ul className="mt-0.5 flex max-h-48 flex-wrap gap-x-4 gap-y-0.5 overflow-y-auto">
                        {newProjects.map((p) => (
                          <li key={p.id} className="w-72 truncate text-sm text-slate-700">
                            {p.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Suppliers */}
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      Suppliers
                    </span>
                    {isAdmin && (
                      <form action={syncQboSuppliers}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync suppliers from QuickBooks
                        </SubmitButton>
                      </form>
                    )}
                    <span className="flex-1" />
                    <Link
                      href="/settings/suppliers"
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      Manage suppliers →
                    </Link>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Read-only from QuickBooks — Flow never creates suppliers.
                    OCR vendor names are matched against this list. Set
                    category/class/tax/currency/payment-term defaults per
                    supplier on the Manage suppliers page.
                  </p>
                  <div className="mt-1 text-xs text-slate-400">
                    {suppliersCount != null
                      ? `${suppliersCount} supplier${suppliersCount === 1 ? "" : "s"} on File. `
                      : ""}
                    {suppliersLastSync ? (
                      <>Last synced on {fmtSync(suppliersLastSync)}.</>
                    ) : (
                      <>Not synced yet.</>
                    )}
                  </div>
                  {newSuppliers.length > 0 && (
                    <div className="mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Newly synced
                      </div>
                      <ul className="mt-0.5 flex max-h-48 flex-wrap gap-x-4 gap-y-0.5 overflow-y-auto">
                        {newSuppliers.map((s) => (
                          <li key={s.id} className="w-64 truncate text-sm text-slate-700">
                            {s.name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Categories (Chart of Accounts) — one list, account
                    numbers starting with 2, 5, or 6 */}
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      Categories
                    </span>
                    {isAdmin && (
                      <form action={syncQboCategories}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync categories from QuickBooks
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    One list from QuickBooks — every account whose number
                    starts with 2, 5, or 6.
                  </p>
                  <div className="mt-1 text-xs text-slate-400">
                    {categoriesCount != null
                      ? `${categoriesCount} categor${categoriesCount === 1 ? "y" : "ies"} on File. `
                      : ""}
                    {categoriesLastSync ? (
                      <>Last synced on {fmtSync(categoriesLastSync)}.</>
                    ) : (
                      <>Not synced yet.</>
                    )}
                  </div>
                  {newCategories.length > 0 && (
                    <div className="mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Newly synced
                      </div>
                      <ul className="mt-0.5 max-h-48 divide-y divide-slate-100 overflow-y-auto">
                        {newCategories.map((c) => (
                          <li
                            key={c.id}
                            className="flex flex-wrap items-center gap-2 py-1.5 text-sm"
                          >
                            <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
                              {c.acct_num ? `${c.acct_num} - ${c.name}` : c.name}
                            </span>
                            <span className="text-xs text-slate-400">
                              {c.account_type ?? "—"}
                              {c.account_sub_type ? ` · ${c.account_sub_type}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Billing & usage */}
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Billing &amp; usage</h2>
            <p className="mt-1 text-sm text-slate-500">
              Usage for {org.name} — the suggested monthly charge is
              invoices processed × your per-invoice rate (set{" "}
              <code className="rounded bg-slate-100 px-1">BILLING_RATE_PER_INVOICE</code>).
              Bill your customer manually for now; automated invoicing
              (Stripe) can be added later when you sell to more customers.
            </p>
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-slate-700">
                  <strong>{org.name}</strong> —{" "}
                  {new Date().toLocaleString(undefined, {
                    month: "long",
                    year: "numeric",
                  })}
                </span>
                <span className="flex-1" />
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {usageTotal} invoices this month
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {[...usageByStatus.entries()].map(([status, count]) => (
                  <div key={status}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {status.replace(/_/g, " ")}
                    </dt>
                    <dd className="text-lg font-semibold text-slate-800">
                      {count}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-slate-500">
                  {usageTotal} × ${rate.toFixed(2)} per invoice
                </span>
                <span className="text-base font-bold text-slate-900">
                  ${suggestedCharge.toFixed(2)} / month
                </span>
              </div>
            </div>
          </section>

          {/* Members */}
          <section className="mt-10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Members</h2>
              {isAdmin && (
                <AddUsersModal
                  inviteAction={inviteMember.bind(null, org.id)}
                  roles={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                />
              )}
            </div>

            <div className="mt-3 w-80">
              <SearchInput defaultValue={q} />
            </div>

            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">2FA</th>
                    <th className="px-4 py-3 font-medium">Substitute</th>
                    <th className="px-4 py-3 font-medium">Start date</th>
                    <th className="px-4 py-3 font-medium">End date</th>
                    <th className="px-4 py-3 font-medium">Time zone</th>
                    {isAdmin && <th className="px-4 py-3 font-medium">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleMembers.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar
                            name={nameById.get(m.user_id) ?? "Team member"}
                            photoUrl={avatarById.get(m.user_id)}
                            size="sm"
                          />
                          <span className="font-medium text-slate-800">
                            {nameById.get(m.user_id) ?? "Team member"}
                          </span>
                          {m.user_id === user.id && (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                              you
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {emailById.get(m.user_id) ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin ? (
                          <InlineSelectSave
                            name="role"
                            defaultValue={m.role}
                            options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                            action={updateMemberRole.bind(null, m.id)}
                          />
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                            {ROLE_LABELS[m.role]}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-slate-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          Active
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {mfaEnabledById.get(m.user_id) ? "Enabled" : "Disabled"}
                      </td>
                      <td className="px-4 py-3 text-slate-400">—</td>
                      <td className="px-4 py-3 text-slate-400">—</td>
                      <td className="px-4 py-3 text-slate-400">—</td>
                      <td className="px-4 py-3 text-slate-400">—</td>
                      {isAdmin && (
                        <td className="px-4 py-3">
                          {m.user_id !== user.id && (
                            <form action={removeMember.bind(null, m.id)}>
                              <SubmitButton className="text-xs text-red-500 hover:underline">
                                Remove
                              </SubmitButton>
                            </form>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {visibleMembers.length === 0 && (
                    <tr>
                      <td
                        colSpan={isAdmin ? 10 : 9}
                        className="px-4 py-8 text-center text-slate-400"
                      >
                        No members match &quot;{q}&quot;.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
              <SubmitButton className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Add
              </SubmitButton>
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
                    <SubmitButton className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700">
                      Save
                    </SubmitButton>
                  </form>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <span className="flex-1" />
                    <form action={deleteProject.bind(null, p.id)}>
                      <SubmitButton className="text-xs text-red-500 hover:underline">
                        Delete
                      </SubmitButton>
                    </form>
                  </div>
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
