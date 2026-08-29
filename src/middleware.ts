import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase auth session cookie on every request so server
// components always see a valid (non-expired) session.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: request.headers } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // A slow/unresponsive Supabase Auth call must never be allowed to hang
  // this middleware — it runs on every request across the whole site, so
  // Supabase having a bad moment would otherwise take the entire app down
  // with a Vercel MIDDLEWARE_INVOCATION_TIMEOUT (504) for every visitor,
  // exactly as happened live. getUser()'s return value isn't even used —
  // its only job here is the side effect of refreshing the session cookie
  // via the setAll callback above — so giving up after a few seconds and
  // serving the request anyway just risks one request seeing a stale
  // session, which self-corrects on the next one, instead of a full outage.
  const authPromise = supabase.auth.getUser().catch(() => {});
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([authPromise, timeout]);

  // Per-user opt-in MFA (see SecurityMfaSection.tsx): once someone has
  // enrolled a verified TOTP factor, every session must complete that
  // second step before it counts as fully signed in — this is the one
  // central place that's enforced, rather than scattering the check
  // across every page/action. getAuthenticatorAssuranceLevel() compares
  // this session's current level against what the account actually
  // requires; a mismatch (aal1 but aal2 required) means the password/
  // magic-link/OAuth step succeeded but the 6-digit code hasn't been
  // entered yet. Same 5s-timeout guard as getUser() above — never let a
  // slow Auth call hang every request. Excludes /login* (the challenge
  // page itself lives at /login/mfa) and /api/webhooks (already excluded
  // via the matcher, but /api/* generally still needs this same gate).
  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith("/login")) {
    const aalPromise = supabase.auth.mfa.getAuthenticatorAssuranceLevel().catch(() => null);
    const aalTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    const aal = await Promise.race([aalPromise, aalTimeout]);
    if (aal?.data && aal.data.currentLevel === "aal1" && aal.data.nextLevel === "aal2") {
      const redirectUrl = new URL("/login/mfa", request.url);
      redirectUrl.searchParams.set("next", pathname + request.nextUrl.search);
      return NextResponse.redirect(redirectUrl);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/webhooks).*)"],
};
