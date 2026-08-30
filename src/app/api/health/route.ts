import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Unauthenticated on purpose — meant to be hit by an external uptime
// monitor (UptimeRobot, Better Uptime, etc.), not a signed-in user. Runs
// one cheap query to prove the DB connection itself is alive, not just
// that the Next.js process is up.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("organizations").select("id").limit(1);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 503 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 503 }
    );
  }
}
