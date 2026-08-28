import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";

// Self-serve signup (email/password, Google OAuth, or a first-time magic
// link) creates an auth.users row but nothing else — this app is otherwise
// entirely invite-based (an admin adds you to organization_members).
// Called from /auth/callback and /auth/confirm right after establishing a
// session: if the user has no org yet, give them a brand-new one as its
// admin, same shape as the platform-admin's own createOrganizationAction
// but self-triggered. Idempotent (checks first) — safe to call on every
// auth completion, not just the first.
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
  const emailLocal = (user.email ?? "").split("@")[0] || "my";
  const orgName = fullName ? `${fullName}'s organization` : `${emailLocal}'s organization`;

  const baseSlug =
    orgName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org";
  let slug = baseSlug;
  for (let i = 0; i < 20; i++) {
    const { data: slugTaken } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!slugTaken) break;
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const { data: org, error } = await admin
    .from("organizations")
    .insert({ name: orgName, slug })
    .select("id")
    .single();
  if (error || !org) {
    console.error("ensureOrgForNewUser: org create failed", error);
    return;
  }

  await admin
    .from("profiles")
    .upsert({ id: user.id, full_name: fullName }, { onConflict: "id", ignoreDuplicates: true });
  await admin
    .from("organization_members")
    .insert({ organization_id: org.id, user_id: user.id, role: "admin" });
}
