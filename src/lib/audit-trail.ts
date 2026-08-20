import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { buildPdf, type PdfLine } from "@/lib/pdf";

// Builds the audit PDF for one invoice: invoice metadata, the approval
// trail (who decided what at which step), the full chat history, and the
// raw audit log. This is ONE of the two files attached to the bill when the
// invoice syncs to QuickBooks — the other is the original invoice document.
// Authored by Araza.

export interface InvoiceAuditDocument {
  filename: string;
  pdf: Buffer;
}

export async function buildInvoiceAuditDocument(
  supabase: SupabaseClient<Database>,
  invoiceId: string
): Promise<InvoiceAuditDocument | null> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return null;

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", invoice.organization_id)
    .single();

  const steps = invoice.workflow_id
    ? ((await supabase
        .from("approval_workflow_steps")
        .select("*")
        .eq("workflow_id", invoice.workflow_id)
        .order("step_order", { ascending: true })).data ?? [])
    : [];

  const approvals =
    (await supabase
      .from("invoice_approvals")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("step_order", { ascending: true })).data ?? [];

  const comments =
    (await supabase
      .from("invoice_comments")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: true })).data ?? [];

  const auditEntries =
    (await supabase
      .from("audit_log")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: true })).data ?? [];

  // Resolve display names for everyone who touched this invoice.
  const profileIds = [
    invoice.submitted_by,
    ...approvals.map((a) => a.approver_id),
    ...comments.map((c) => c.author_id),
    ...auditEntries.map((a) => a.actor_id),
  ].filter((id): id is string => !!id);

  const names = new Map<string, string>();
  if (profileIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", profileIds);
    for (const p of profiles ?? []) names.set(p.id, p.full_name ?? "Team member");
  }
  const nameOf = (id: string | null) =>
    id ? names.get(id) ?? id.slice(0, 8) : "—";

  const h = (text: string): PdfLine => ({ text, bold: true });
  const l = (text: string): PdfLine => ({ text, bold: false });
  const blank: PdfLine = { text: "", bold: false };

  const lines: PdfLine[] = [
    h("INVOICE AUDIT TRAIL"),
    l(`Generated: ${new Date().toLocaleString()}`),
    blank,
    l(`Organization:   ${org?.name ?? "Unknown"}`),
    l(`Vendor:         ${invoice.vendor_name ?? "—"}`),
    l(`Invoice #:      ${invoice.invoice_number ?? "—"}`),
    l(
      `Amount:         ${
        invoice.amount != null
          ? invoice.amount.toLocaleString(undefined, {
              style: "currency",
              currency: invoice.currency,
            })
          : "—"
      } (${invoice.currency})`
    ),
    l(`Due date:       ${invoice.due_date ?? "—"}`),
    l(`Status:         ${invoice.status.toUpperCase()}`),
    l(
      `Source:         ${invoice.source}${
        invoice.source_email ? ` (${invoice.source_email})` : ""
      }`
    ),
    l(`Submitted by:   ${nameOf(invoice.submitted_by)}`),
    l(`File:           ${invoice.file_name}`),
    l(`Created:        ${new Date(invoice.created_at).toLocaleString()}`),
    l(`Invoice ID:     ${invoice.id}`),
    blank,
    h("APPROVAL TRAIL"),
  ];

  if (steps.length === 0) {
    lines.push(l("No approval workflow assigned."));
  } else {
    for (const step of steps) {
      const decision = approvals.find(
        (a) => a.step_order === step.step_order
      );
      const isOpen =
        step.step_order === invoice.current_step_order &&
        invoice.status !== "approved" &&
        invoice.status !== "rejected";
      const state = isOpen
        ? "CURRENT STEP"
        : decision
          ? decision.decision.toUpperCase()
          : "NOT DECIDED";
      lines.push(
        l(
          `Step ${step.step_order}: ${nameOf(step.approver_user_id)} — ${state}` +
            (decision
              ? ` (${new Date(decision.decided_at).toLocaleString()}${
                  decision.comment ? ` — "${decision.comment}"` : ""
                })`
              : "")
        )
      );
    }
  }

  lines.push(blank, h("CHAT HISTORY"));
  if (comments.length === 0) {
    lines.push(l("No comments."));
  } else {
    for (const c of comments) {
      lines.push(
        l(`[${new Date(c.created_at).toLocaleString()}] ${nameOf(c.author_id)}: ${c.body}`)
      );
    }
  }

  lines.push(blank, h("AUDIT LOG"));
  if (auditEntries.length === 0) {
    lines.push(l("No audit entries."));
  } else {
    for (const entry of auditEntries) {
      lines.push(
        l(
          `[${new Date(entry.created_at).toLocaleString()}] ${entry.action} (by ${nameOf(entry.actor_id)})`
        )
      );
    }
  }

  lines.push(
    blank,
    l(
      "This document accompanies the approval of this invoice. Together with the"
    ),
    l("original invoice, it is attached to the corresponding bill in QuickBooks.")
  );

  const base = (invoice.vendor_name ?? invoice.file_name ?? "invoice")
    .toLowerCase()
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 60);
  return {
    filename: `audit-trail-${base}-${invoice.id.slice(0, 8)}.pdf`,
    pdf: buildPdf(lines),
  };
}
