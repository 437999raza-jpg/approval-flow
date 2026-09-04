import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { exchangeCodeForTokens } from "@/lib/qbo";

const QBO_OAUTH_STATE_COOKIE = "qbo_oauth_state";

function clearQboOAuthState(response: NextResponse) {
  response.cookies.set(QBO_OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/api/qbo",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}

function qboErrorRedirect(origin: string) {
  return clearQboOAuthState(
    NextResponse.redirect(new URL("/settings?qbo=error#integrations", origin))
  );
}

// QBO OAuth callback. State is a one-time nonce bound to the browser session;
// we also verify the signed-in user is still an admin of that org before
// storing the tokens.
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
  if (!user) {
    return clearQboOAuthState(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
  }

  if (error || !code || !state) {
    return qboErrorRedirect(url.origin);
  }

  const storedState = cookies().get(QBO_OAUTH_STATE_COOKIE)?.value;
  const [expectedState, expectedOrgId] = storedState?.split(":") ?? [];
  if (!expectedState || !expectedOrgId || expectedState !== state) {
    return clearQboOAuthState(
      NextResponse.json({ error: "Invalid QuickBooks state" }, { status: 403 })
    );
  }

  const org = await getCurrentOrg(supabase);
  if (!org || org.id !== expectedOrgId || org.role !== "admin") {
    return clearQboOAuthState(
      NextResponse.json(
        { error: "Not authorized for this organization" },
        { status: 403 }
      )
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const realmId = urlRealmId ?? tokens.realmId;
    if (!realmId) {
      console.error("QBO callback: no realmId in callback URL or token response");
      return qboErrorRedirect(url.origin);
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
          disconnected_at: null,
        },
        { onConflict: "organization_id" }
      );
    return clearQboOAuthState(
      NextResponse.redirect(new URL("/settings?qbo=connected#integrations", url.origin))
    );
  } catch (e) {
    console.error("QBO callback failed:", e instanceof Error ? e.message : e);
    return qboErrorRedirect(url.origin);
  }
}
