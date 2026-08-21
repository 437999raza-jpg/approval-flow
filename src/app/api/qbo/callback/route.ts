import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { exchangeCodeForTokens } from "@/lib/qbo";

// QBO OAuth callback. State carries the org id; we verify the signed-in
// user is an admin of that org before storing the tokens (the connection
// grants the org full API access to its QBO company).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  // Intuit includes the QBO company id (realmId) in the callback URL —
  // use it as the source of truth (fall back to the token response).
  const urlRealmId = url.searchParams.get("realmId");

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (error || !code || !state) {
    return NextResponse.redirect(
      new URL("/settings?qbo=error", url.origin)
    );
  }

  const org = await getCurrentOrg(supabase);
  if (!org || org.id !== state || org.role !== "admin") {
    return NextResponse.json(
      { error: "Not authorized for this organization" },
      { status: 403 }
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const realmId = urlRealmId ?? tokens.realmId;
    if (!realmId) {
      console.error("QBO callback: no realmId in callback URL or token response");
      return NextResponse.redirect(new URL("/settings?qbo=error", url.origin));
    }
    const admin = createAdminClient();
    await admin
      .from("qbo_connections")
      .upsert(
        {
          organization_id: org.id,
          realm_id: realmId,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_at: new Date(
            Date.now() + tokens.expiresIn * 1000
          ).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id" }
      );
    return NextResponse.redirect(
      new URL("/settings?qbo=connected", url.origin)
    );
  } catch (e) {
    console.error("QBO callback failed:", e instanceof Error ? e.message : e);
    return NextResponse.redirect(
      new URL("/settings?qbo=error", url.origin)
    );
  }
}
