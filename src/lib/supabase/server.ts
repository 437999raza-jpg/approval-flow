import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/supabase/types";

// Use inside Server Components, Route Handlers, and Server Actions.
// This client acts as the signed-in user, so RLS policies apply.
//
// cache()'d so every call within the same request (e.g. a shared layout
// and the page it wraps, both calling createClient() independently) gets
// back the SAME client instance — a prerequisite for getCurrentOrg's own
// cache() to actually dedupe (its cache key is this client's identity).
// React's cache() only applies within a Server Component render, not
// across separate requests, so this can't leak one user's client to
// another's request.
export const createClient = cache(function createClient() {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component with no response to write to;
            // middleware.ts refreshes the session cookie on the next request.
          }
        },
      },
    }
  );
});
