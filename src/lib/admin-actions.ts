"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/platform-admin";

const ACTIVE_ORG_COOKIE = "active_org_id";

function setActiveOrgCookie(orgId: string) {
  cookies().set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

// Shared by createOrganizationAction (platform admin provisions a client)
// and completeSelfSignup (auth-actions.ts — a real self-serve signup):
// slug generation, the org row itself, the first admin's membership, and
// the default one-workflow/one-step/one-approver bootstrap so Approve/
// Reject has somewhere to route to from the very first invoice. Returns
// the new org's id, or null with an error code on failure (never redirects
// itself — callers have very different failure UX: one redirects with a
// query param, the other returns {ok,error} to a client component).
export async function bootstrapOrganization(
  admin: ReturnType<typeof createAdminClient>,
  {
    name,
    inboundLocal,
    adminUserId,
    trialEndsAt,
  }: {
    name: string;
    inboundLocal: string | null;
    adminUserId: string;
    trialEndsAt: string | null;
  }
): Promise<{ orgId: string } | { error: "inbound-local-taken" | "create-failed" }> {
  const baseSlug =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org";
  let slug = baseSlug;
  for (let i = 0; i < 20; i++) {
    const { data: existing } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!existing) break;
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({
      name,
      slug,
      inbound_email_local: inboundLocal,
      trial_ends_at: trialEndsAt,
    })
    .select("id")
    .single();

  if (orgError || !org) {
    const code = (orgError as { code?: string } | null)?.code;
    return { error: code === "23505" ? "inbound-local-taken" : "create-failed" };
  }

  await admin.from("organization_members").insert({
    organization_id: org.id,
    user_id: adminUserId,
    role: "admin",
  });

  // Without a default workflow, invoices for this org would have
  // workflow_id = null forever — decide()/reExtractInvoiceCore() and friends
  // treat that as "nothing to do" and silently no-op, so Approve/Reject
  // would never work. Bootstrap the same one-workflow/one-step/one-approver
  // setup the manual SQL in the README used to require, with the new admin
  // as the step's default (catch-all) approver.
  const { data: workflow } = await admin
    .from("approval_workflows")
    .insert({ organization_id: org.id, name: "Default", is_default: true })
    .select("id")
    .single();
  if (workflow) {
    const { data: step } = await admin
      .from("approval_workflow_steps")
      .insert({ workflow_id: workflow.id, step_order: 1, name: "Approval" })
      .select("id")
      .single();
    if (step) {
      await admin.from("approval_workflow_step_approvers").insert({
        step_id: step.id,
        approver_user_id: adminUserId,
        is_default: true,
      });
    }
  }

  return { orgId: org.id };
}

// Platform-admin only: provision a brand-new tenant (organization) plus its
// first admin user, in one step. This is the ASSISTED onboarding path —
// see completeSelfSignup (auth-actions.ts) for the real self-serve one now
// wired up on /login.
export async function createOrganizationAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isPlatformAdmin(user.email)) redirect("/login");

  const orgName = String(formData.get("org_name") ?? "").trim();
  const adminEmail = String(formData.get("admin_email") ?? "").trim().toLowerCase();
  const adminName = String(formData.get("admin_name") ?? "").trim() || null;
  const inboundLocalRaw = String(formData.get("inbound_local") ?? "").trim().toLowerCase();

  if (!orgName || !adminEmail) {
    redirect("/admin/organizations?error=missing-fields");
  }

  if (inboundLocalRaw && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(inboundLocalRaw)) {
    redirect("/admin/organizations?error=bad-inbound-local");
  }
  const inboundLocal = inboundLocalRaw || null;

  const admin = createAdminClient();

  // Create (or reuse) the first admin's auth account — same approach as the
  // existing per-org inviteMember action in src/app/settings/page.tsx.
  let userId: string | null = null;
  const { data: created } = await admin.auth.admin.createUser({
    email: adminEmail,
    email_confirm: true,
  });
  if (created?.user) {
    userId = created.user.id;
  } else {
    const { data: listed } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    userId = listed?.users.find((u) => u.email?.toLowerCase() === adminEmail)?.id ?? null;
  }

  if (!userId) {
    redirect(`/admin/organizations?error=invite-failed`);
  }

  await admin.from("profiles").upsert(
    { id: userId, full_name: adminName },
    { onConflict: "id", ignoreDuplicates: true }
  );

  const result = await bootstrapOrganization(admin, {
    name: orgName,
    inboundLocal,
    adminUserId: userId,
    trialEndsAt: null, // platform-admin-provisioned orgs aren't on a trial clock
  });
  if ("error" in result) {
    redirect(`/admin/organizations?error=${result.error}`);
  }

  // Give the platform admin standing support access to every org they
  // create — they need to be able to see what a client is doing/sharing to
  // actually support them, not just have created the tenant once. Skipped
  // when the platform admin IS the org's own first admin (e.g. testing) to
  // avoid a duplicate-membership insert.
  if (user.id !== userId) {
    await admin.from("organization_members").insert({
      organization_id: result.orgId,
      user_id: user.id,
      role: "admin",
    });
  }

  revalidatePath("/admin/organizations");
  redirect(`/admin/organizations?created=${result.orgId}`);
}

// Platform-admin only: grant yourself standing support access to an org
// that predates the auto-membership above (or where you were removed), then
// switch into it. Idempotent — re-joining an org you're already in is a
// no-op past the upsert.
export async function joinOrganizationAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isPlatformAdmin(user.email)) redirect("/login");

  const orgId = String(formData.get("org_id") ?? "");
  if (!orgId) redirect("/admin/organizations");

  const admin = createAdminClient();
  await admin.from("profiles").upsert(
    { id: user.id },
    { onConflict: "id", ignoreDuplicates: true }
  );
  await admin
    .from("organization_members")
    .upsert(
      { organization_id: orgId, user_id: user.id, role: "admin" },
      { onConflict: "organization_id,user_id", ignoreDuplicates: true }
    );

  setActiveOrgCookie(orgId);
  // Lets the /admin/organizations "View support chat" button land on the
  // dashboard with that org's support widget already open, instead of a
  // bare dashboard — same join-and-switch, different destination. The
  // widget itself lives on /dashboard now (a floating popup, not its own
  // page — see SupportChatWidget.tsx), so this no longer points at
  // /support directly.
  const redirectTo = String(formData.get("redirect_to") ?? "").trim();
  redirect(redirectTo === "/dashboard?openSupport=1" ? "/dashboard?openSupport=1" : "/dashboard");
}

// Switch which of your orgs you're viewing. Only ever meaningful for
// someone with more than one organization_members row (the platform admin);
// everyone else has exactly one, so the OrgSwitcher UI doesn't even render.
// Re-verifies membership server-side rather than trusting the submitted id.
export async function switchOrgAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const orgId = String(formData.get("org_id") ?? "");
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!membership) redirect("/dashboard");

  setActiveOrgCookie(orgId);
  redirect("/dashboard");
}

// Platform-admin only: push out an org's trial by N days. Extends from
// whichever is LATER — today, or the trial's current expiry — so
// extending an already-active trial adds time on top instead of
// (if it had already lapsed) resetting the clock to start from a past
// date and leaving it still expired.
export async function extendTrialAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isPlatformAdmin(user.email)) redirect("/login");

  const orgId = String(formData.get("org_id") ?? "");
  const days = Number(formData.get("days") ?? 14);
  if (!orgId || !Number.isFinite(days) || days <= 0) {
    redirect("/admin/organizations?error=bad-extend");
  }

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("trial_ends_at")
    .eq("id", orgId)
    .single();
  if (!org) redirect("/admin/organizations?error=create-failed");

  const currentExpiry = org.trial_ends_at ? new Date(org.trial_ends_at) : new Date();
  const base = currentExpiry > new Date() ? currentExpiry : new Date();
  const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  await admin
    .from("organizations")
    .update({ trial_ends_at: newExpiry.toISOString() })
    .eq("id", orgId);

  revalidatePath("/admin/organizations");
  redirect("/admin/organizations");
}

// Platform-admin only: which extraction mode an org's invoices use.
// 'detailed' (default) is today's full line-by-line extraction; 'simple'
// builds one line item per invoice from the document's subtotal + the
// vendor's saved supplier default category (see buildSimpleLineItem in
// src/lib/invoices.ts). This is a separate axis from `plan` on purpose —
// it isn't wired into PLANS/pricing, so it can be sold however the
// business lands on without another code change.
export async function setExtractionModeAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isPlatformAdmin(user.email)) redirect("/login");

  const orgId = String(formData.get("org_id") ?? "");
  const mode = String(formData.get("extraction_mode") ?? "");
  if (!orgId || (mode !== "detailed" && mode !== "simple")) {
    redirect("/admin/organizations?error=bad-extraction-mode");
  }

  const admin = createAdminClient();
  await admin
    .from("organizations")
    .update({ extraction_mode: mode })
    .eq("id", orgId);

  revalidatePath("/admin/organizations");
  redirect("/admin/organizations");
}
