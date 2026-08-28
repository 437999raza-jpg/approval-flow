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

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/webhooks).*)"],
};
