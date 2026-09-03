import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { disconnectQbo, refreshQboData, saveDefaultTaxRate, saveInboundEmailLocal, saveStatementReplyTo, syncQboTaxes, syncQboClasses, syncQboCategories, syncQboSuppliers, syncQboProjects, syncQboPaymentStatus } from "@/lib/dashboard-actions";
import { StatementReplyToForm } from "@/components/StatementReplyToForm";
import { SecurityMfaSection } from "@/components/SecurityMfaSection";
import { qboEnv } from "@/lib/qbo";
import { Avatar } from "@/components/Avatar";
import { AvatarUploadForm } from "@/components/AvatarUploadForm";
import { AddUsersModal } from "@/components/AddUsersModal";
import { MemberFilterInput } from "@/components/MemberFilterInput";
import { InlineSelectSave } from "@/components/InlineSelectSave";
import { SubstitutePicker } from "@/components/SubstitutePicker";
import { InlineTextSave } from "@/components/InlineTextSave";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { DefaultTaxRateForm } from "@/components/DefaultTaxRateForm";
import { InboundEmailForm } from "@/components/InboundEmailForm";
import { ScrollPreserveForm } from "@/components/ScrollPreserveForm";
import { ScrollRestorer } from "@/components/ScrollRestorer";
import { StickyHeader } from "@/components/StickyHeader";
import { LocalTime } from "@/components/LocalTime";
import { membersTag } from "@/lib/org-cache";
import { isBusinessEmail, BUSINESS_EMAIL_MESSAGE } from "@/lib/business-email";
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
  "personal-email": BUSINESS_EMAIL_MESSAGE,
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
  // Teammates go through the same business-domain rule as signup —
  // otherwise the front door is locked while the side door isn't.
  if (!isBusinessEmail(email)) redirect("/settings?error=personal-email#members");

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

  if (!userId) redirect("/settings?error=invite-failed#members");

  // Ensure a profile row exists (admin client bypasses RLS). Only sets the
  // name on first creation — never overwrites a name the user set themselves.
  await admin.from("profiles").upsert(
    { id: userId, full_name: fullName },
    { onConflict: "id", ignoreDuplicates: true }
  );

  const { error: memberError } = await supabase
    .from("organization_members")
    .insert({ organization_id: orgId, user_id: userId, role });
  if (memberError) redirect("/settings?error=already-member#members");

  revalidateTag(membersTag(orgId)); // cached member roster changed
  revalidatePath("/settings");
  redirect("/settings#members");
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

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("id", membershipId)
    .single();

  await supabase
    .from("organization_members")
    .update({ role })
    .eq("id", membershipId);

  if (membership?.organization_id) {
    revalidateTag(membersTag(membership.organization_id));
  }
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
    .select("user_id, organization_id")
    .eq("id", membershipId)
    .single();
  if (!member || member.user_id === user.id) return;

  await supabase.from("organization_members").delete().eq("id", membershipId);

  if (member.organization_id) {
    revalidateTag(membersTag(member.organization_id));
  }
  revalidatePath("/settings");
}

// Sets (or clears) who stands in for a member while they're away —
// migration 0094. Cover is what actually prevents a stalled step: an
// approver on holiday is the most common reason a bill sits untouched,
// and no escalation policy fixes that on its own, it only reports it
// after the fact.
//
// Anyone may set their OWN cover (you shouldn't need an admin to go on
// holiday); only admins may set someone else's.
async function saveSubstitute(membershipId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: member } = await supabase
    .from("organization_members")
    .select("user_id, organization_id")
    .eq("id", membershipId)
    .single();
  if (!member) return;

  if (member.user_id !== user.id) {
    const org = await getCurrentOrg(supabase);
    if (!org || org.role !== "admin" || org.id !== member.organization_id) return;
  }

  const substituteRaw = String(formData.get("substitute_user_id") ?? "").trim();
  const untilRaw = String(formData.get("substitute_until") ?? "").trim();

  // The DB rejects self-cover too (check constraint), but failing here
  // keeps it a no-op rather than a thrown error in the UI.
  if (substituteRaw && substituteRaw === member.user_id) return;

  // Clearing the person clears the date with it — a date with nobody to
  // cover is meaningless state that would just confuse the next reader.
  const substituteUserId = substituteRaw || null;
  const substituteUntil =
    substituteUserId && /^\d{4}-\d{2}-\d{2}$/.test(untilRaw) ? untilRaw : null;

  await supabase
    .from("organization_members")
    .update({
      substitute_user_id: substituteUserId,
      substitute_until: substituteUntil,
    })
    .eq("id", membershipId);

  revalidateTag(membersTag(member.organization_id));
  revalidatePath("/settings");
  redirect("/settings#members");
}

// Admin-facing recovery for a teammate who lost their authenticator
// device AND their saved recovery codes — the one remaining gap after
// self-service recovery codes (see mfa-recovery.ts): before this,
// nothing in the app could help someone in that state. Turning off
// someone else's 2FA needs the ADMIN client (auth.admin.mfa.*), which
// bypasses RLS entirely, so — unlike updateMemberRole/removeMember
// above, which lean on RLS to enforce "caller must be admin" — this
// explicitly re-verifies both that the caller is an admin of the
// target's org AND that the target is actually a member of that same
// org, before touching anything. Combined with the existing "Join as
// support" flow (which already grants a platform admin `role: 'admin'`
// on any org — admin-actions.ts), this also covers the case where an
// entire org, including its only admin, is locked out.
async function resetMemberMfa(membershipId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") return;

  const { data: member } = await supabase
    .from("organization_members")
    .select("user_id, organization_id")
    .eq("id", membershipId)
    .eq("organization_id", org.id)
    .single();
  if (!member) return;

  const admin = createAdminClient();
  const { data: factorData } = await admin.auth.admin.mfa.listFactors({
    userId: member.user_id,
  });
  const verified = factorData?.factors?.find(
    (f) => f.factor_type === "totp" && f.status === "verified"
  );
  if (verified) {
    await admin.auth.admin.mfa.deleteFactor({ id: verified.id, userId: member.user_id });
  }

  revalidatePath("/settings");
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { error?: string; q?: string; qbo?: string; count?: string; taxdefault?: string; rate?: string; mfa?: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The shared layout ((app)/layout.tsx) already redirects to /dashboard
  // when there's no org — Dashboard has the canonical "no organization
  // yet" screen — so this is only a type-narrowing guard, never actually
  // reachable in practice.
  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");

  const isAdmin = org.role === "admin";
  // Plain "user" members only ever see their own profile here — Integrations/
  // Billing/Members/Projects are admin-and-auditor territory (auditor keeps
  // its existing full-app read-only visibility; this only narrows "user").
  const showOrgSettings = org.role !== "user";

  // Everything here is independent of everything else in this batch (all
  // scoped only by org.id) — one Promise.all instead of ~9 sequential
  // round trips, same fix as the Dashboard page's per-navigation queries.
  const [
    { data: orgReplyToRow },
    { data: qboConnection },
    { data: qboTaxCodes },
    { data: qboSyncLog },
    { count: classesCount },
    { count: categoriesCount },
    { count: suppliersCount },
    { count: projectsCount },
    { data: members },
  ] = await Promise.all([
    supabase
      .from("organizations")
      .select("statement_reply_to")
      .eq("id", org.id)
      .single(),
    // QBO connection (RLS: admins only — everyone else sees nothing).
    supabase
      .from("qbo_connections")
      .select("realm_id, company_name, connected_at")
      .eq("organization_id", org.id)
      .maybeSingle(),
    // Tax codes with resolved rates pulled from QBO (read-only mirror) —
    // the codes are what the bill's Tax field offers, exactly like Dext.
    // Only codes with a usable rate are listed (H 13%, M&E 13%, Out of
    // Scope 0%).
    supabase
      .from("qbo_tax_codes")
      .select("qbo_tax_code_id, name, rate_value")
      .eq("organization_id", org.id)
      .not("rate_value", "is", null)
      .order("name", { ascending: true })
      .limit(50),
    // Per-section sync log (migration 0049): when each QBO mirror was last
    // synced, so sections can show "N on File. Last synced on <time>".
    supabase
      .from("qbo_sync_log")
      .select("section, synced_at")
      .eq("organization_id", org.id),
    // Exact "on file" counts — PostgREST caps row responses at 1000 rows,
    // so use head + count=exact rather than fetching the lists.
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
    supabase
      .from("organization_members")
      .select("id, user_id, role, substitute_user_id, substitute_until")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: true }),
  ]);

  // Default-tax choices = the synced tax CODES (H 13%, M&E (ON) 13%…).
  // Stored as a code so ingest puts the exact code on new lines — two codes
  // can share a rate and the QBO sync refuses to guess between them.
  const defaultTaxCodes = (qboTaxCodes ?? []).map((c) => ({
    id: c.qbo_tax_code_id,
    name: c.name,
    rate: c.rate_value,
  }));

  const lastSyncBySection = new Map(
    (qboSyncLog ?? []).map((r) => [r.section, r.synced_at])
  );
  const classesLastSync = lastSyncBySection.get("classes");
  const categoriesLastSync = lastSyncBySection.get("categories");
  const suppliersLastSync = lastSyncBySection.get("suppliers");
  const projectsLastSync = lastSyncBySection.get("projects");
  const paymentStatusLastSync = lastSyncBySection.get("payment_status");

  const inboundEmailDomain =
    process.env.INBOUND_EMAIL_DOMAIN ?? "invoices.example.com";

  // Names + photos from profiles, emails + 2FA status from auth (admin
  // client) — depends on `members` above, but not on any of the "new
  // since last sync" queries below, so both run as one more parallel
  // batch rather than two more sequential round trips.
  const userIds = [...new Set((members ?? []).map((m) => m.user_id))];

  // ONLY the items that are NEW in the most recent sync run get listed in
  // each section (first_seen_at >= that run's log timestamp). Blank when
  // nothing new — the section never synced shows nothing either.
  const [
    { data: newClassesData },
    { data: newCategoriesData },
    { data: newSuppliersData },
    { data: newProjectsData },
    { data: profiles },
  ] = await Promise.all([
    classesLastSync
      ? supabase
          .from("qbo_classes")
          .select("id, name")
          .eq("organization_id", org.id)
          .gte("first_seen_at", classesLastSync)
          .order("name", { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [] }),
    categoriesLastSync
      ? supabase
          .from("qbo_categories")
          .select("id, name, acct_num, account_type, account_sub_type")
          .eq("organization_id", org.id)
          .gte("first_seen_at", categoriesLastSync)
          .order("name", { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [] }),
    suppliersLastSync
      ? supabase
          .from("qbo_suppliers")
          .select("id, name")
          .eq("organization_id", org.id)
          .gte("first_seen_at", suppliersLastSync)
          .order("name", { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [] }),
    projectsLastSync
      ? supabase
          .from("projects")
          .select("id, name")
          .eq("organization_id", org.id)
          .eq("source", "qbo")
          .gte("first_seen_at", projectsLastSync)
          .order("name", { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [] }),
    userIds.length > 0
      ? supabase.from("profiles").select("id, full_name, avatar_url").in("id", userIds)
      : Promise.resolve({ data: [] }),
  ]);
  const newClasses = newClassesData ?? [];
  const newCategories = newCategoriesData ?? [];
  const newSuppliers = newSuppliersData ?? [];
  const newProjects = newProjectsData ?? [];
  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
  );
  const avatarById = new Map((profiles ?? []).map((p) => [p.id, p.avatar_url]));

  const admin = createAdminClient();
  // One per-member getUserById pass covers both email AND MFA status — not
  // a bulk listUsers({ perPage: 1000 }) for email plus a SEPARATE per-user
  // pass for MFA. GoTrue's bulk listUsers() doesn't include each user's
  // enrolled factors at all (confirmed live: every member showed
  // "Disabled" regardless of actual status until this was caught) — only
  // the single-user endpoint returns `factors`, and its response already
  // carries `.email` too, so the bulk call was pure redundant work. Org
  // membership lists are small enough that N individual calls is a
  // non-issue.
  const userDetails = await Promise.all(
    userIds.map((id) => admin.auth.admin.getUserById(id))
  );
  const emailById = new Map(
    userIds.map((id, i) => [id, userDetails[i].data.user?.email ?? null])
  );
  const mfaEnabledById = new Map(
    userIds.map((id, i) => {
      const u = userDetails[i].data.user;
      return [
        id,
        Array.isArray(u?.factors) && u.factors.some((f) => f.status === "verified"),
      ];
    })
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

  return (
    <main className="mx-auto w-full max-w-6xl px-8 pb-8">
      {/* Heading + subtitle + the section jump-nav are one sticky unit,
          not just the nav on its own — a section taller than the
          viewport needs to stay reachable without ever pushing the
          heading itself out of view. StickyHeader also measures its own
          rendered height and applies it as scroll-padding-top on the
          scrolling pane, so whichever section a pill jumps to always
          clears the header by exactly the right amount — no hand-tuned
          scroll-mt-* guess to keep in sync with the header's actual
          height (which drifted out of sync the moment the header's own
          height changed). */}
      <StickyHeader>
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-brand-ink">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          {org.name} · you are {ROLE_LABELS[org.role]}
        </p>

        {/* In-page section jump-nav — the app-wide sidebar (AppSidebar,
            via the shared layout) covers cross-page navigation now; this
            is purely for switching between sections on THIS page. */}
        <nav className="settings-tab-nav mt-4 flex flex-wrap gap-1.5 border-b border-slate-200 pb-4">
          <a href="#profile" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
            My profile
          </a>
          <a href="#security" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
            Security
          </a>
          {showOrgSettings && (
            <>
              <a href="#integrations" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
                Integrations
              </a>
              <a href="#invoice-email" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
                Invoice email
              </a>
              <a href="#billing" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
                Billing &amp; usage
              </a>
              <a href="#members" className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
                Members
              </a>
            </>
          )}
        </nav>
      </StickyHeader>

      {/* Only one section shows at a time now — pure CSS via :target, no
          client JS needed. .settings-panel defaults to hidden; the one
          matching the URL's #hash is shown; with no hash anywhere on the
          page, the first panel (My profile) shows. Every redirect that
          lands back on this page after an action now carries the right
          #hash (see ScrollPreserveForm for the ones that can't set it
          server-side, e.g. the QBO sync buttons). Every panel is a
          direct #hash target now — Invoice email used to be a sub-anchor
          nested inside Integrations (so opening it also showed all of
          Integrations' content above it), now it's its own panel. */}
      <style>{`
        .settings-tabs .settings-panel { display: none; }
        .settings-tabs .settings-panel:target { display: block; }
        .settings-tabs:not(:has(:target)) .settings-panel:first-of-type { display: block; }

        /* Selected-tab state, driven by the same :target the panels use, so
           the pill row can't drift out of sync with what's showing. Without
           this every pill rendered identically no matter which panel was
           open — the tab bar gave no indication of where you were. Brand
           green (#57A14C at 10%) matches the sidebar's own active state. */
        main:has(#profile:target) .settings-tab-nav a[href="#profile"],
        main:has(#security:target) .settings-tab-nav a[href="#security"],
        main:has(#integrations:target) .settings-tab-nav a[href="#integrations"],
        main:has(#invoice-email:target) .settings-tab-nav a[href="#invoice-email"],
        main:has(#billing:target) .settings-tab-nav a[href="#billing"],
        main:has(#members:target) .settings-tab-nav a[href="#members"],
        main:not(:has(:target)) .settings-tab-nav a[href="#profile"] {
          background-color: rgba(87, 161, 76, 0.12);
          color: #3E7D36;
          font-weight: 600;
        }
      `}</style>

          {/* Puts the page back where you were after a sync/save button
              press (those redirect, and redirects scroll to the top). */}
          <ScrollRestorer />

          {searchParams.error && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {SETTINGS_ERRORS[searchParams.error] ??
                "That action could not be completed."}
            </div>
          )}

          {searchParams.mfa === "reset" && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              You used a recovery code to sign in, which turned off
              two-factor authentication on your account. Set it up again
              below under Security.
            </div>
          )}

          <div className="settings-tabs">

          {/* My profile */}
          <section id="profile" className="settings-panel mt-8">
            <h2 className="text-xl font-semibold text-brand-ink">My profile</h2>
            <div className="mt-3 flex items-center gap-4 rounded-lg border border-slate-200 bg-white shadow-elevation-1 p-4">
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

          {/* Security — per-user opt-in, set up under your own login (not
              admin-assignable; an admin can only see the status below in
              the Members table and remind someone directly). */}
          <section id="security" className="settings-panel mt-8">
            <h2 className="text-xl font-semibold text-brand-ink">Security</h2>
            <p className="mt-1 text-sm text-slate-500">
              Two-factor authentication for your own account.
            </p>
            <SecurityMfaSection initialEnabled={mfaEnabledById.get(user.id) ?? false} />
          </section>

          {showOrgSettings && (
          <>
          {/* Integrations */}
          <section id="integrations" className="settings-panel mt-8">
            <h2 className="text-xl font-semibold text-brand-ink">Integrations</h2>
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
            {searchParams.qbo === "payment_status_synced" && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Updated payment status on {searchParams.count ?? 0} bill
                {searchParams.count === "1" ? "" : "s"} from QuickBooks.
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
            <div className="mt-3 rounded-lg border border-slate-200 bg-white shadow-elevation-1 p-4 text-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
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
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Data from QuickBooks
                  </div>
                  <span className="flex-1" />
                  {isAdmin && qboConnection && (
                    <ScrollPreserveForm action={refreshQboData}>
                      <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                        Refresh data
                      </SubmitButton>
                    </ScrollPreserveForm>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  QuickBooks is the source of truth. These lists are pulled
                  read-only — when you add or update tax rates, classes,
                  categories, or suppliers in QuickBooks, refresh to bring
                  the changes into Flow. Nothing is ever written to
                  QuickBooks from Flow.
                </p>

                {/* Each mirror collapses by default — six of these stacked
                    open at once (plus Suppliers/Projects routinely running
                    into the thousands) made this page enormous. The sync
                    button lives inside now, alongside the count/status —
                    expand a section to check or re-sync it. */}
                <div className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                  {/* Tax codes (what the bill's Tax field offers) */}
                  <CollapsibleSection
                    title="Tax"
                    badge={qboTaxCodes?.length ?? undefined}
                    defaultOpen={false}
                  >
                    {isAdmin && (
                      <ScrollPreserveForm action={syncQboTaxes}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync taxes from QuickBooks
                        </SubmitButton>
                      </ScrollPreserveForm>
                    )}
                    <p className="mt-2 text-xs text-slate-500">
                      These are the codes the bill&apos;s Tax field offers —
                      type &quot;h&quot; for HST, like Dext. Only active QBO
                      codes appear.
                    </p>
                    {qboTaxCodes && qboTaxCodes.length > 0 ? (
                      <ul className="mt-2 space-y-0.5">
                        {(qboTaxCodes ?? []).map((c) => (
                          <li key={c.qbo_tax_code_id} className="text-sm text-slate-700">
                            {c.name} ({c.rate_value}%)
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-sm text-slate-400">
                        No tax data synced yet.
                      </p>
                    )}

                    {isAdmin && qboTaxCodes && qboTaxCodes.length > 0 && (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Default tax rate for new invoices
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          Applied to every incoming invoice when the supplier
                          has no rule of their own. Choose one of the synced
                          tax codes (e.g. H 13%).
                        </p>
                        <DefaultTaxRateForm
                          currentCodeId={org.default_tax_code_id}
                          currentRate={org.default_tax_rate}
                          codes={defaultTaxCodes}
                          action={saveDefaultTaxRate}
                        />
                      </div>
                    )}
                  </CollapsibleSection>

                  {/* Classes */}
                  <CollapsibleSection
                    title="Classes"
                    badge={classesCount ?? undefined}
                    defaultOpen={false}
                  >
                    {isAdmin && (
                      <ScrollPreserveForm action={syncQboClasses}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync classes from QuickBooks
                        </SubmitButton>
                      </ScrollPreserveForm>
                    )}
                    <p className="mt-2 text-xs text-slate-500">
                      New classes added in QuickBooks show up here after a
                      sync.
                    </p>
                    <div className="mt-1 text-xs text-slate-400">
                      {classesLastSync ? (
                        <>Last synced on <LocalTime iso={classesLastSync} withYear />.</>
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
                  </CollapsibleSection>

                  {/* Projects */}
                  <CollapsibleSection
                    title="Projects"
                    badge={projectsCount ?? undefined}
                    defaultOpen={false}
                  >
                    {isAdmin && (
                      <ScrollPreserveForm action={syncQboProjects}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync projects from QuickBooks
                        </SubmitButton>
                      </ScrollPreserveForm>
                    )}
                    <p className="mt-2 text-xs text-slate-500">
                      Read-only from QuickBooks — these are the QBO projects
                      (customers with IsProject=true). Regular customers are
                      not imported.
                    </p>
                    <div className="mt-1 text-xs text-slate-400">
                      {projectsLastSync ? (
                        <>Last synced on <LocalTime iso={projectsLastSync} withYear />.</>
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
                  </CollapsibleSection>

                  {/* Suppliers */}
                  <CollapsibleSection
                    title="Suppliers"
                    badge={suppliersCount ?? undefined}
                    defaultOpen={false}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {isAdmin && (
                        <ScrollPreserveForm action={syncQboSuppliers}>
                          <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                            Sync suppliers from QuickBooks
                          </SubmitButton>
                        </ScrollPreserveForm>
                      )}
                      <span className="flex-1" />
                      <Link
                        href="/settings/suppliers"
                        className="text-xs font-medium text-blue-600 hover:underline"
                      >
                        Manage suppliers →
                      </Link>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Read-only from QuickBooks — Flow never creates suppliers.
                      OCR vendor names are matched against this list. Set
                      category/class/tax/currency/payment-term defaults per
                      supplier on the Manage suppliers page.
                    </p>
                    <div className="mt-1 text-xs text-slate-400">
                      {suppliersLastSync ? (
                        <>Last synced on <LocalTime iso={suppliersLastSync} withYear />.</>
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
                  </CollapsibleSection>

                  {/* Categories (Chart of Accounts) — one list, account
                      numbers starting with 2, 5, or 6 */}
                  <CollapsibleSection
                    title="Categories"
                    badge={categoriesCount ?? undefined}
                    defaultOpen={false}
                  >
                    {isAdmin && (
                      <ScrollPreserveForm action={syncQboCategories}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync categories from QuickBooks
                        </SubmitButton>
                      </ScrollPreserveForm>
                    )}
                    <p className="mt-2 text-xs text-slate-500">
                      One list from QuickBooks — every account whose number
                      starts with 2, 5, or 6.
                    </p>
                    <div className="mt-1 text-xs text-slate-400">
                      {categoriesLastSync ? (
                        <>Last synced on <LocalTime iso={categoriesLastSync} withYear />.</>
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
                  </CollapsibleSection>

                  {/* Payment status — pulls Paid/Unpaid + date paid from QBO
                      for every bill this org has already synced there. Same
                      thing runs nightly at 2am (vercel.json cron); this is
                      just the on-demand version. */}
                  <CollapsibleSection title="Payment status" defaultOpen={false}>
                    {isAdmin && (
                      <ScrollPreserveForm action={syncQboPaymentStatus}>
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Sync payment status from QuickBooks
                        </SubmitButton>
                      </ScrollPreserveForm>
                    )}
                    <p className="mt-2 text-xs text-slate-500">
                      Read-only from QuickBooks — checks every bill Flow has
                      already pushed there and marks it Paid/Unpaid (with the
                      date paid) on the bill itself. Runs automatically every
                      night at 2am; this button runs it right now instead of
                      waiting.
                    </p>
                    <div className="mt-1 text-xs text-slate-400">
                      {paymentStatusLastSync ? (
                        <>Last synced on <LocalTime iso={paymentStatusLastSync} withYear />.</>
                      ) : (
                        <>Not synced yet.</>
                      )}
                    </div>
                  </CollapsibleSection>
                </div>
              </div>
            </div>
          </section>

          {/* Invoice email — its own tab now, not nested inside
              Integrations (it used to be a sub-anchor within that
              section, so opening it also showed all of Integrations'
              QBO content above it). Inbound capture address on our
              domain (ApprovalMax/Dext model: {companyname}@ourdomain,
              clients change nothing), plus where a vendor's Statement
              Reconciliation reply lands. */}
          <section id="invoice-email" className="settings-panel mt-8">
            <h2 className="text-xl font-semibold text-brand-ink">Invoice email</h2>
            <p className="mt-1 text-sm text-slate-500">
              Invoices emailed to your capture address land in the app
              automatically. The address is on our domain — your suppliers
              just send to it, and there is nothing to set up on your side.
            </p>
            <div className="mt-3 rounded-lg border border-slate-200 bg-white shadow-elevation-1 p-4 text-sm">
              {isAdmin ? (
                <InboundEmailForm
                  domain={inboundEmailDomain}
                  currentLocal={org.inbound_email_local}
                  currentToken={org.inbound_email_token}
                  action={saveInboundEmailLocal}
                />
              ) : (
                <p className="text-xs text-slate-500">
                  Your capture address is{" "}
                  <span className="font-mono font-semibold text-slate-800">
                    {org.inbound_email_local ?? org.inbound_email_token}@
                    {inboundEmailDomain}
                  </span>
                  .
                </p>
              )}
            </div>

            {/* Statement Reconciliation vendor emails — Flow still sends
                from its own verified address, this only controls where a
                vendor's reply lands. */}
            <div className="mt-3 rounded-lg border border-slate-200 bg-white shadow-elevation-1 p-4 text-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Vendor email reply-to
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Used by Statement Reconciliation&apos;s &quot;email the vendor&quot; feature — sets
                where a vendor&apos;s reply goes.
              </p>
              {isAdmin ? (
                <StatementReplyToForm
                  currentValue={orgReplyToRow?.statement_reply_to ?? null}
                  action={saveStatementReplyTo}
                />
              ) : (
                <p className="mt-2 text-xs text-slate-500">
                  {orgReplyToRow?.statement_reply_to ?? "Not set."}
                </p>
              )}
            </div>
          </section>

          {/* Billing & usage — lives on its own page now */}
          <section id="billing" className="settings-panel mt-8">
            <h2 className="text-xl font-semibold text-brand-ink">Billing &amp; usage</h2>
            <p className="mt-1 text-sm text-slate-500">
              Documents processed, the suggested charge at your per-document
              rate, and the recent documents list live on the{" "}
              <a
                href="/billing"
                className="font-medium text-blue-600 hover:underline"
              >
                Billing page →
              </a>
            </p>
          </section>

          {/* Members */}
          <section id="members" className="settings-panel mt-10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-brand-ink">Members</h2>
              {isAdmin && (
                <AddUsersModal
                  inviteAction={inviteMember.bind(null, org.id)}
                  roles={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                />
              )}
            </div>

            <div className="mt-3">
              <MemberFilterInput defaultValue={q} />
            </div>

            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-elevation-1">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">2FA</th>
                    <th className="px-4 py-3 font-medium">Covered by</th>
                    {/* Substitute / Start date / End date / Time zone lived
                        here but had no backing feature yet, so every row
                        rendered four columns of em dashes — ~350px of dead
                        width that pushed the table into a horizontal
                        scrollbar. Add them back with the feature, not
                        before it. */}
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
                        <span className="inline-flex items-center gap-2">
                          {/* Same dot-chip pattern as the Status column
                              (green "Active" above) — green for
                              protected, an outlined grey chip rather
                              than colored-in for "off" so it doesn't
                              read as a second, competing status. */}
                          {mfaEnabledById.get(m.user_id) ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Enabled
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-500">
                              <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                              Disabled
                            </span>
                          )}
                          {isAdmin && mfaEnabledById.get(m.user_id) && m.user_id !== user.id && (
                            <ConfirmSubmitButton
                              action={resetMemberMfa.bind(null, m.id)}
                              confirmMessage="Reset this person's two-factor authentication? They'll be signed in without it and can set it up again."
                              className="text-xs text-slate-400 hover:text-red-500 hover:underline"
                            >
                              Reset
                            </ConfirmSubmitButton>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin || m.user_id === user.id ? (
                          <SubstitutePicker
                            action={saveSubstitute.bind(null, m.id)}
                            currentSubstituteId={m.substitute_user_id}
                            currentUntil={m.substitute_until}
                            options={(members ?? [])
                              .filter((other) => other.user_id !== m.user_id)
                              .map((other) => ({
                                value: other.user_id,
                                label: nameById.get(other.user_id) ?? "Team member",
                              }))}
                          />
                        ) : m.substitute_user_id ? (
                          <span className="text-xs text-slate-500">
                            {nameById.get(m.substitute_user_id) ?? "Team member"}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
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
                        colSpan={isAdmin ? 7 : 6}
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

          </>
          )}

          </div>
    </main>
  );
}
