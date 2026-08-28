"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Post into this org's one continuous support thread. RLS (is_org_member)
// is the real gate — any member can post, no role restriction, since
// reaching support shouldn't require admin permissions.
export async function postSupportMessage(organizationId: string, formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  await supabase.from("support_messages").insert({
    organization_id: organizationId,
    author_id: user.id,
    body,
  });

  revalidatePath("/support");
}
