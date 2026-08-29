"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bootstrapOrganization } from "@/lib/admin-actions";

const TRIAL_DAYS = 14;

// Real self-serve signup: called from the client right after
// supabase.auth.signUp() resolves with a live session (email
// confirmation is off for this project — see login/page.tsx's signUp
// handler), before it routes to /dashboard. Creates the caller's own
// organization (reusing the exact same bootstrap the platform-admin
// /admin/organizations flow uses — one default workflow/step/approver,
// so Approve/Reject works from the first invoice) and starts their
// 14-day trial. Authored by Araza.
export async function completeSelfSignup(
  orgName: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = orgName.trim();
  if (!name) return { ok: false, error: "Enter a company name." };

  // Someone who already belongs to an org (shouldn't normally reach this
  // — a brand-new signUp() has no membership yet) skips straight to the
  // dashboard rather than getting a second organization.
  const { data: existingMembership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingMembership) return { ok: true };

  const admin = createAdminClient();
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = await bootstrapOrganization(admin, {
    name,
    inboundLocal: null,
    adminUserId: user.id,
    trialEndsAt,
  });
  if ("error" in result) {
    return {
      ok: false,
      error:
        result.error === "inbound-local-taken"
          ? "That company name is already in use — try a slightly different name."
          : "Could not create your organization — please try again.",
    };
  }

  return { ok: true };
}
