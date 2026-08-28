import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { isPlatformAdmin } from "@/lib/platform-admin";

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
  const [{ data: profiles }, { data: authUsers }] = await Promise.all([
    authorIds.length > 0
      ? supabase.from("profiles").select("id, full_name").in("id", authorIds)
      : Promise.resolve({ data: [] }),
    authorIds.length > 0
      ? createAdminClient().auth.admin.listUsers({ page: 1, perPage: 1000 })
      : Promise.resolve({ data: { users: [] } }),
  ]);
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"]));
  const emailById = new Map((authUsers?.users ?? []).map((u) => [u.id, u.email ?? null]));

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

  return NextResponse.json({ ok: true });
}
