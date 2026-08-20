import { createClient } from "@/lib/supabase/server";
import { buildInvoiceAuditDocument } from "@/lib/audit-trail";

// Download the audit PDF (chat history + approval audit trail) for an
// invoice. Authenticated; RLS scopes it to the caller's org. This is one of
// the two files attached to the QBO bill on sync — the other is the original
// invoice document (see src/lib/qbo-attachments.ts). Authored by Araza.
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

  return new Response(new Uint8Array(doc.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${doc.filename}"`,
    },
  });
}
