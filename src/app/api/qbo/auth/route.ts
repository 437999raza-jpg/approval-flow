import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { qboAuthorizeUrl, qboEnv } from "@/lib/qbo";

// Start the QuickBooks OAuth flow. Admins only (the connection grants the
// org full access to its QBO company). Redirects to Intuit's authorize
// screen; state carries the org id so the callback can store the tokens.
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

  const url = qboAuthorizeUrl(org.id);
  return NextResponse.redirect(url!);
}
