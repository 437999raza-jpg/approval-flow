import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { ensureOrgForNewUser } from "@/lib/onboarding";
import { isBusinessEmail } from "@/lib/business-email";
import { isPlatformAdmin } from "@/lib/platform-admin";

// Companion to /auth/callback: handles the `token_hash` + `type` form of
// email confirmation links (Supabase's documented pattern for OTP/magic-link
// email templates), as opposed to the PKCE `?code=` form. Also where a
// brand-new signup's "confirm your email" link lands (type=signup) —
// verifying it both confirms the address and establishes the session.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/dashboard";

  if (tokenHash && type) {
    const supabase = createClient();
    const { data, error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      // Same business-domain rule as /auth/callback — see the comment
      // there. Enforced on both routes because either can be the one that
      // first establishes a session for a brand-new account.
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

    // The token is single-use. If something already consumed it (e.g. a
    // browser/security prefetch of the link before the real click) but that
    // earlier hit set a valid session, treat this as success too.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      if (!isBusinessEmail(user.email) && !isPlatformAdmin(user.email)) {
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/login?error=business_email`);
      }
      await ensureOrgForNewUser(supabase, user);
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_confirm_failed`);
}
