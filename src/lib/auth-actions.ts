"use server";

import { createClient } from "@/lib/supabase/server";
import { ensureOrgForNewUser } from "@/lib/onboarding";

// Real self-serve signup: called from the client right after
// supabase.auth.signUp() resolves with a live session (only reachable
// when email confirmation is off — otherwise ensureOrgForNewUser instead
// fires from /auth/confirm once they click the emailed link, reading the
// same company_name passed in signUp's options.data). Both paths funnel
// through the one ensureOrgForNewUser implementation (onboarding.ts) so
// there's only one place that actually creates the organization.
// Authored by Araza.
export async function completeSelfSignup(
  orgName: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  await ensureOrgForNewUser(supabase, {
    id: user.id,
    email: user.email,
    user_metadata: { ...user.user_metadata, company_name: orgName },
  });

  return { ok: true };
}
