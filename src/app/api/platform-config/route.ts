import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Polled by UpdateAvailableBanner: a bump in config_version (fired by a DB
// trigger whenever a feature flag changes — see migration 0077) tells
// every open browser tab something changed and it should refresh to pick
// it up. Reads nothing sensitive, so any signed-in user can call this.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("platform_config")
    .select("config_version")
    .eq("id", true)
    .maybeSingle();

  return NextResponse.json({ configVersion: data?.config_version ?? 1 });
}
