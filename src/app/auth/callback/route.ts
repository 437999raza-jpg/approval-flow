import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureOrgForNewUser } from "@/lib/onboarding";
import { isBusinessEmail } from "@/lib/business-email";
import { isPlatformAdmin } from "@/lib/platform-admin";

// Supabase's magic-link email points here with a `?code=` param (PKCE
// flow) — and so does Google OAuth (signInWithOAuth's redirectTo), which
// lands on the exact same `?code=` exchange with no provider-specific
// handling needed. Exchanging it sets the session cookie via the server
// client, then we redirect on to wherever the sign-in was headed.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Business domains only. This has to happen server-side and AFTER
      // the exchange, because with OAuth we never see the address until
      // the provider hands it back — the provider buttons themselves are
      // fine (a Google Workspace company signs in as name@company.com),
      // it's a personal mailbox behind any provider that isn't.
      // Signing them straight back out avoids stranding a half-created
      // account in the app with no organization.
      // isPlatformAdmin bypasses it: the operator account in
      // PLATFORM_ADMIN_EMAILS is not a tenant and may legitimately be on
      // any domain — locking it out would lock us out of /admin.
      if (
        data.user &&
        !isBusinessEmail(data.user.email) &&
        !isPlatformAdmin(data.user.email)
      ) {
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/login?error=business_email`);
      }
      if (data.user) await ensureOrgForNewUser(supabase, data.user);
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
