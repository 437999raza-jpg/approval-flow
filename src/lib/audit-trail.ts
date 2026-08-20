import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Builds a plain-text audit document for one invoice: org + invoice metadata,
// the approval trail (who decided what at which step), the full chat history,
// and the raw audit log. This is the seed for the QBO attachment: when
// invoice sync to QuickBooks lands, this document (or a PDF render of it)
// gets attached to the pushed bill.
// Authored by Araza.

export interface InvoiceAuditDocument {
  filename: string;
  text: string;
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

  const lines: string[] = [];
  const now = new Date().toLocaleString();

  lines.push("APPROVAL FLOW — INVOICE AUDIT TRAIL");
  lines.push(`Generated: ${now}`);
  lines.push("=".repeat(60));
  lines.push("");
  lines.push(`Organization:   ${org?.name ?? "Unknown"}`);
  lines.push(`Vendor:         ${invoice.vendor_name ?? "—"}`);
  lines.push(`Invoice #:      ${invoice.invoice_number ?? "—"}`);
  lines.push(
    `Amount:         ${invoice.amount != null ? invoice.amount.toLocaleString(undefined, { style: "currency", currency: invoice.currency }) : "—"} (${invoice.currency})`
  );
  lines.push(`Due date:       ${invoice.due_date ?? "—"}`);
  lines.push(`Status:         ${invoice.status.toUpperCase()}`);
  lines.push(`Source:         ${invoice.source}${invoice.source_email ? ` (${invoice.source_email})` : ""}`);
  lines.push(`Submitted by:   ${nameOf(invoice.submitted_by)}`);
  lines.push(`File:           ${invoice.file_name}`);
  lines.push(`Created:        ${new Date(invoice.created_at).toLocaleString()}`);
  lines.push(`Invoice ID:     ${invoice.id}`);

  lines.push("");
  lines.push("APPROVAL TRAIL");
  lines.push("-".repeat(60));
  if (steps.length === 0) {
    lines.push("No approval workflow assigned.");
  } else {
    for (const step of steps) {
      const decision = approvals.find((a) => a.step_order === step.step_order);
      const stepState = step.step_order === invoice.current_step_order && invoice.status !== "approved" && invoice.status !== "rejected"
        ? "CURRENT STEP"
        : invoice.status === "approved" || invoice.status === "rejected"
          ? decision
            ? decision.decision.toUpperCase()
            : "NOT DECIDED"
          : decision
            ? decision.decision.toUpperCase()
            : "NOT DECIDED";
      lines.push(
        `Step ${step.step_order}: ${nameOf(step.approver_user_id)} — ${stepState}` +
          (decision
            ? ` (${new Date(decision.decided_at).toLocaleString()}${decision.comment ? ` — "${decision.comment}"` : ""})`
            : "")
      );
    }
  }

  lines.push("");
  lines.push("CHAT HISTORY");
  lines.push("-".repeat(60));
  if (comments.length === 0) {
    lines.push("No comments.");
  } else {
    for (const c of comments) {
      lines.push(
        `[${new Date(c.created_at).toLocaleString()}] ${nameOf(c.author_id)}: ${c.body}`
      );
    }
  }

  lines.push("");
  lines.push("AUDIT LOG");
  lines.push("-".repeat(60));
  if (auditEntries.length === 0) {
    lines.push("No audit entries.");
  } else {
    for (const entry of auditEntries) {
      lines.push(
        `[${new Date(entry.created_at).toLocaleString()}] ${entry.action} (by ${nameOf(entry.actor_id)})`
      );
    }
  }

  lines.push("");
  lines.push("=".repeat(60));
  lines.push("This document accompanies the approval of this invoice. It will be");
  lines.push("attached to the corresponding bill when synced to QuickBooks.");

  const base = (invoice.vendor_name ?? invoice.file_name ?? "invoice")
    .toLowerCase()
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 60);
  return {
    filename: `audit-trail-${base}-${invoice.id.slice(0, 8)}.txt`,
    text: lines.join("\n"),
  };
}
