import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Supabase's magic-link email points here with a `?code=` param (PKCE flow).
// Exchanging it sets the session cookie via the server client, then we
// redirect on to wherever the sign-in was headed.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
