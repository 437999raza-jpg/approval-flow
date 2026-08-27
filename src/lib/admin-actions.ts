"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/platform-admin";

// Platform-admin only: provision a brand-new tenant (organization) plus its
// first admin user, in one step. There's no self-serve signup — a new
// client is onboarded the same way an ApprovalMax rep onboards one: someone
// running the platform creates the org and hands the client's first admin
// their sign-in email + the org's inbound invoice address.
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

  const baseSlug =
    orgName
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
    .insert({ name: orgName, slug, inbound_email_local: inboundLocal })
    .select("id")
    .single();

  if (orgError || !org) {
    const code = (orgError as { code?: string } | null)?.code;
    redirect(
      `/admin/organizations?error=${code === "23505" ? "inbound-local-taken" : "create-failed"}`
    );
  }

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
    redirect(`/admin/organizations?error=invite-failed&org=${org.id}`);
  }

  await admin.from("profiles").upsert(
    { id: userId, full_name: adminName },
    { onConflict: "id", ignoreDuplicates: true }
  );

  await admin.from("organization_members").insert({
    organization_id: org.id,
    user_id: userId,
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
        approver_user_id: userId,
        is_default: true,
      });
    }
  }

  revalidatePath("/admin/organizations");
  redirect(`/admin/organizations?created=${org.id}`);
}
