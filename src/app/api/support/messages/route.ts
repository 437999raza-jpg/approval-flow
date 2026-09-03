import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { isPlatformAdmin, platformAdminEmails } from "@/lib/platform-admin";
import { sendSupportMessageEmail } from "@/lib/notify";
import { getAppUrl } from "@/lib/app-url";

// Backs the floating support chat widget (SupportChatWidget.tsx) — a
// dedicated JSON endpoint rather than reusing the /support page's Server
// Component + router.refresh() pattern, so polling the thread doesn't
// also re-fetch and re-render whatever heavy page (the dashboard, most
// often) the widget is floating on top of.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await getCurrentOrg(supabase);
  if (!org) return NextResponse.json({ error: "no organization" }, { status: 404 });

  const { data: messages } = await supabase
    .from("support_messages")
    .select("*")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: true });

  const authorIds = [
    ...new Set((messages ?? []).map((m) => m.author_id).filter((id): id is string => !!id)),
  ];
  // Per-author lookups, not a bulk listUsers({ perPage: 1000 }) — this
  // endpoint is polled every 4s while the widget is open (plus once right
  // after every send), and a thread only ever has a handful of distinct
  // authors, so fetching up to 1000 users platform-wide on every poll was
  // pure waste (and a real source of the multi-second send-to-visible
  // delay reported live). Same fix already applied to the Members table's
  // 2FA status for the identical reason.
  const admin = createAdminClient();
  const [{ data: profiles }, authUserResults] = await Promise.all([
    authorIds.length > 0
      ? supabase.from("profiles").select("id, full_name").in("id", authorIds)
      : Promise.resolve({ data: [] }),
    Promise.all(authorIds.map((id) => admin.auth.admin.getUserById(id))),
  ]);
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"]));
  const emailById = new Map(
    authorIds.map((id, i) => [id, authUserResults[i].data.user?.email ?? null])
  );

  const out = (messages ?? []).map((m) => ({
    id: m.id,
    body: m.body,
    createdAt: m.created_at,
    isMe: m.author_id === user.id,
    authorName: m.author_id ? nameById.get(m.author_id) ?? "Team member" : "Someone",
    isSupport: isPlatformAdmin(m.author_id ? emailById.get(m.author_id) ?? null : null),
  }));

  return NextResponse.json({ messages: out });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const org = await getCurrentOrg(supabase);
  if (!org) return NextResponse.json({ error: "no organization" }, { status: 404 });

  const { body } = (await request.json()) as { body?: string };
  const text = String(body ?? "").trim();
  if (!text) return NextResponse.json({ error: "empty message" }, { status: 400 });

  const { error } = await supabase.from("support_messages").insert({
    organization_id: org.id,
    author_id: user.id,
    body: text,
  });
  if (error) return NextResponse.json({ error: "insert failed" }, { status: 500 });

  // Only a customer's message needs to reach us — a platform admin
  // replying here shouldn't email themselves. Best-effort: notify.ts's
  // sendEmail already swallows its own failures, so this never blocks
  // the response.
  if (!isPlatformAdmin(user.email)) {
    const admins = platformAdminEmails();
    if (admins.length > 0) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();
      const opsAppUrl = process.env.OPS_APP_URL;
      const threadUrl = opsAppUrl ? `${opsAppUrl}/support/${org.id}` : getAppUrl();
      await Promise.all(
        admins.map((to) =>
          sendSupportMessageEmail({
            to,
            orgName: org.name,
            authorName: profile?.full_name ?? user.email ?? "A customer",
            body: text,
            threadUrl,
          })
        )
      );
    }
  }

  return NextResponse.json({ ok: true });
}
