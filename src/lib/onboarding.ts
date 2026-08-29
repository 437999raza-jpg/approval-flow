import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { bootstrapOrganization } from "@/lib/admin-actions";

const TRIAL_DAYS = 14;

// Self-serve signup (email/password, Google/Microsoft/Apple OAuth, or a
// first-time magic link) creates an auth.users row but nothing else —
// this app is otherwise entirely invite-based (an admin adds you to
// organization_members). Called from /auth/callback and /auth/confirm
// right after establishing a session, and from completeSelfSignup
// (auth-actions.ts) for the immediate-session signUp path — whichever
// fires first wins, this is idempotent (checks membership first). Gives
// the user a brand-new organization as its admin, using
// bootstrapOrganization (admin-actions.ts) — the SAME default
// workflow/step/approver bootstrap the platform-admin's own
// createOrganizationAction uses, so Approve/Reject works from the first
// invoice — plus a 14-day trial with full product access.
export async function ensureOrgForNewUser(
  supabase: SupabaseClient<Database>,
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> }
): Promise<void> {
  const { data: existing } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (existing) return;

  const admin = createAdminClient();

  const fullName =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    null;
  const companyName = (user.user_metadata?.company_name as string | undefined)?.trim() || null;
  const emailLocal = (user.email ?? "").split("@")[0] || "my";
  const orgName = companyName || (fullName ? `${fullName}'s organization` : `${emailLocal}'s organization`);

  await admin
    .from("profiles")
    .upsert({ id: user.id, full_name: fullName }, { onConflict: "id", ignoreDuplicates: true });

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await bootstrapOrganization(admin, {
    name: orgName,
    inboundLocal: null,
    adminUserId: user.id,
    trialEndsAt,
  });
  if ("error" in result) {
    console.error("ensureOrgForNewUser: bootstrapOrganization failed", result.error);
  }
}
