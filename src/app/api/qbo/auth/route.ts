import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { qboAuthorizeUrl, qboEnv } from "@/lib/qbo";

const QBO_OAUTH_STATE_COOKIE = "qbo_oauth_state";
const QBO_OAUTH_STATE_MAX_AGE = 10 * 60; // 10 minutes

// Start the QuickBooks OAuth flow. Admins only (the connection grants the
// org full access to its QBO company). Redirects to Intuit's authorize
// screen; state is a one-time nonce bound to this browser session.
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can connect QuickBooks" },
      { status: 403 }
    );
  }

  if (!qboEnv()) {
    return NextResponse.json(
      {
        error:
          "QBO not configured — set QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI in .env.local",
      },
      { status: 500 }
    );
  }

  const state = crypto.randomUUID();
  const url = qboAuthorizeUrl(state);
  const response = NextResponse.redirect(url!);
  response.cookies.set(QBO_OAUTH_STATE_COOKIE, `${state}:${org.id}`, {
    httpOnly: true,
    maxAge: QBO_OAUTH_STATE_MAX_AGE,
    path: "/api/qbo",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
