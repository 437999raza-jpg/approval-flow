import { createClient } from "@/lib/supabase/server";
import { buildInvoiceAuditDocument } from "@/lib/audit-trail";

// Download the full audit document (approval trail + chat history + audit
// log) for an invoice. Authenticated; RLS scopes it to the caller's org.
// This is the same document that will be attached to the QBO bill on sync.
// Authored by Araza.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const doc = await buildInvoiceAuditDocument(supabase, params.id);
  if (!doc) return new Response("Not found", { status: 404 });

  return new Response(doc.text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${doc.filename}"`,
    },
  });
}
