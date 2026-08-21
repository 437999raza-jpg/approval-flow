import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { buildPdf, textWidth, type PdfLine } from "@/lib/pdf";
import { buildAuditTimeline } from "@/lib/audit-timeline";

// Builds the audit PDF for one invoice: header with status badge, invoice
// summary, approval log (table), line items (table) with totals,
// instructions for accounting, and a single chronological timeline of
// everything else that happened (bill edits, line item changes,
// documents, status overrides, discussion). Styled after the Dext-style
// audit report this app's users already expect. This is ONE of the two
// files attached to the bill when the invoice syncs to QuickBooks — the
// other is the original invoice document. Authored by Araza.

export interface InvoiceAuditDocument {
  filename: string;
  pdf: Buffer;
}

const CONTENT_W = 512; // page width minus both margins

const STATUS_LABELS: Record<string, string> = {
  on_review: "ON REVIEW",
  on_approval: "ON APPROVAL",
  approved: "APPROVED",
  cancelled: "CANCELLED",
  rejected: "REJECTED",
  on_hold: "ON HOLD",
};

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

  const lineItems =
    (await supabase
      .from("invoice_line_items")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("line_order", { ascending: true })).data ?? [];

  const profileIds = [
    invoice.submitted_by,
    ...steps.map((s) => s.approver_user_id),
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
  const nameOf = (id: string | null) => (id ? names.get(id) ?? id.slice(0, 8) : "System");

  const timeline = buildAuditTimeline({ auditEntries, comments, nameOf });

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const fmtAmount = (n: number | null) =>
    n != null ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

  // --- Primitives -------------------------------------------------------
  const rule = (spaceBefore = 10, gray = 0.85): PdfLine => ({ rule: true, spaceBefore, gray });
  const sectionHeader = (text: string): PdfLine => ({
    text,
    bold: true,
    size: 11,
    spaceBefore: 18,
    gray: 0.2,
  });
  const tableHeader = (cols: { text: string; x: number; align?: "left" | "right" }[]): PdfLine => ({
    cells: cols.map((c) => ({ text: c.text.toUpperCase(), x: c.x, align: c.align, bold: true, size: 8, gray: 0.5 })),
    spaceBefore: 10,
  });

  const lines: PdfLine[] = [];

  // --- Header: title + amount, metadata + status badge ------------------
  const amountText = `${fmtAmount(invoice.amount)} ${invoice.currency}`;
  lines.push({
    size: 15,
    cells: [
      {
        text: `Bill ${invoice.invoice_number ?? "-"} from ${invoice.vendor_name ?? invoice.file_name}`,
        x: 0,
        bold: true,
        size: 15,
        maxWidth: CONTENT_W - textWidth(amountText, 15, true) - 16,
      },
      { text: amountText, x: CONTENT_W, align: "right", bold: true, size: 15 },
    ],
  });

  const statusLabel = STATUS_LABELS[invoice.status] ?? invoice.status.toUpperCase();
  const badgeW = textWidth(statusLabel, 9, true) + 20;
  lines.push(
    { text: "Organization", gray: 0.5, size: 9, spaceBefore: 16 },
    {
      cells: [
        { text: org?.name ?? "Unknown", x: 0, size: 10 },
        { text: statusLabel, x: CONTENT_W - 10, align: "right", bold: true, size: 9, gray: 0.25 },
      ],
      box: { x: CONTENT_W - badgeW, width: badgeW, height: 18, borderGray: 0.6 },
    },
    { text: "Generated", gray: 0.5, size: 9, spaceBefore: 8 },
    { text: new Date().toLocaleString(), size: 10 },
    { text: "Submitted by", gray: 0.5, size: 9, spaceBefore: 8 },
    { text: nameOf(invoice.submitted_by), size: 10 },
    rule(16)
  );

  // --- Approval log -------------------------------------------------
  lines.push(sectionHeader("Approval log"));
  const approvalCols = [
    { text: "Name", x: 0 },
    { text: "Step", x: 220 },
    { text: "Decision", x: 340 },
    { text: "Date / time", x: 420 },
  ];
  if (steps.length === 0) {
    lines.push({ text: "No approval workflow assigned.", size: 10, spaceBefore: 8 });
  } else {
    lines.push(tableHeader(approvalCols));
    for (const step of steps) {
      const decision = approvals.find((a) => a.step_order === step.step_order);
      const isOpen =
        step.step_order === invoice.current_step_order &&
        invoice.status !== "approved" &&
        invoice.status !== "rejected" &&
        invoice.status !== "cancelled";
      const state = isOpen ? "Awaiting" : decision ? decision.decision : "Not decided";
      const approverId = step.approver_user_id;
      lines.push({
        cells: [
          { text: nameOf(approverId), x: 0, bold: true, size: 10, maxWidth: 210 },
          { text: `Step ${step.step_order}`, x: 220, size: 10 },
          { text: state.charAt(0).toUpperCase() + state.slice(1), x: 340, size: 10 },
          {
            text: decision ? new Date(decision.decided_at).toLocaleDateString() : "-",
            x: 420,
            size: 10,
          },
        ],
        spaceBefore: 10,
      });
      if (decision?.comment) {
        lines.push({ text: `"${decision.comment}"`, size: 9, gray: 0.4, indent: 8 });
      }
    }
  }
  lines.push(rule(14));

  // --- Invoice fields -------------------------------------------------
  lines.push(
    sectionHeader("Invoice"),
    {
      cells: [
        { text: "Number", x: 0, gray: 0.5, size: 9 },
        { text: "Date", x: 170, gray: 0.5, size: 9 },
        { text: "Due date", x: 340, gray: 0.5, size: 9 },
      ],
      spaceBefore: 8,
    },
    {
      cells: [
        { text: invoice.invoice_number ?? "—", x: 0, size: 10 },
        { text: invoice.bill_date ?? "—", x: 170, size: 10 },
        { text: invoice.due_date ?? "—", x: 340, size: 10 },
      ],
    },
    rule(14)
  );

  // --- Line items -------------------------------------------------
  lines.push(sectionHeader(`Line items (${lineItems.length})`));
  if (lineItems.length === 0) {
    lines.push({ text: "No line items.", size: 10, spaceBefore: 8 });
  } else {
    const itemCols = [
      { text: "Category", x: 0 },
      { text: "Description", x: 80 },
      { text: "Tax %", x: 290, align: "right" as const },
      { text: "Class", x: 310 },
      { text: "Amount", x: CONTENT_W, align: "right" as const },
    ];
    lines.push(tableHeader(itemCols));
    for (const item of lineItems) {
      lines.push({
        cells: [
          { text: item.category ?? "-", x: 0, size: 9.5, maxWidth: 70 },
          { text: item.description ?? "-", x: 80, size: 9.5, maxWidth: 165 },
          { text: item.tax_rate != null ? `${item.tax_rate}%` : "-", x: 290, align: "right", size: 9.5 },
          { text: item.class ?? "-", x: 310, size: 9.5, maxWidth: 130 },
          { text: fmtAmount(item.amount), x: CONTENT_W, align: "right", size: 9.5 },
        ],
        spaceBefore: 8,
      });
    }
  }
  const subtotal = invoice.amount != null && invoice.tax_amount != null
    ? invoice.amount - invoice.tax_amount
    : null;
  lines.push(
    rule(10),
    {
      cells: [
        { text: "Subtotal", x: 400, gray: 0.5, size: 9.5 },
        { text: fmtAmount(subtotal), x: CONTENT_W, align: "right", size: 9.5 },
      ],
      spaceBefore: 8,
    },
    {
      cells: [
        { text: "Tax", x: 400, gray: 0.5, size: 9.5 },
        { text: fmtAmount(invoice.tax_amount), x: CONTENT_W, align: "right", size: 9.5 },
      ],
    },
    {
      cells: [
        { text: "Total", x: 400, bold: true, size: 11 },
        { text: `${fmtAmount(invoice.amount)} ${invoice.currency}`, x: CONTENT_W, align: "right", bold: true, size: 11 },
      ],
      spaceBefore: 4,
    }
  );

  // --- Instructions for accounting -------------------------------------------------
  lines.push(
    rule(16),
    sectionHeader("Instructions for accounting"),
    invoice.accounting_instructions
      ? { text: invoice.accounting_instructions, size: 10, spaceBefore: 8 }
      : { text: "None.", size: 10, gray: 0.5, spaceBefore: 8 }
  );

  // --- Timeline (audit log + discussion, merged & chronological) -------------------------------------------------
  lines.push(rule(16), sectionHeader("Timeline"));
  if (timeline.length === 0) {
    lines.push({ text: "No activity recorded.", size: 10, spaceBefore: 8 });
  } else {
    for (const entry of timeline) {
      const actorW = Math.min(textWidth(entry.actorName, 9.5, true), 140);
      const summaryX = actorW + 15;
      lines.push({
        cells: [
          { text: entry.actorName, x: 0, bold: true, size: 9.5, maxWidth: 135 },
          {
            text: entry.kind === "comment" ? "commented" : entry.summary,
            x: summaryX,
            size: 9.5,
            maxWidth: CONTENT_W - 110 - summaryX,
          },
          { text: fmtDate(entry.at), x: CONTENT_W, align: "right", size: 8, gray: 0.5 },
        ],
        spaceBefore: 9,
      });
      if (entry.detail) {
        lines.push({ text: entry.detail, size: 9, gray: 0.45, indent: 8 });
      }
    }
  }

  lines.push(
    rule(18),
    { text: invoice.file_name, size: 9, gray: 0.5 },
    {
      text: "This document accompanies the approval of this invoice. Together with the original invoice, it is attached to the corresponding bill in QuickBooks.",
      size: 8,
      gray: 0.55,
      spaceBefore: 6,
    }
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
