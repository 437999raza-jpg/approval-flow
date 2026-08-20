import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Service-role client: bypasses RLS. Server-only — never import this from
// client components or expose SUPABASE_SERVICE_ROLE_KEY to the browser.
// Used by the inbound-email webhook, which has no logged-in user/session
// to authenticate as.
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
