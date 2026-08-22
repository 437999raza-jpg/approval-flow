import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { buildPdf, textWidth, wrapLine, type PdfColor, type PdfLine } from "@/lib/pdf";
import { buildAuditTimeline } from "@/lib/audit-timeline";
import {
  effectiveApproversForStep,
  type StepApprover,
  type StepCondition,
} from "@/lib/workflow-conditions";

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

// "vendor_name.invoice_number" (e.g. "marsil_mechanical_inc.6595") for
// naming files that travel with the bill — the audit PDF and, in QBO, the
// original invoice document too. Falls back to the invoice id's first 8
// characters only when there's genuinely no invoice number to use.
export function invoiceFileBase(invoice: {
  vendor_name: string | null;
  invoice_number: string | null;
  file_name: string | null;
  id: string;
}): string {
  const vendor = (invoice.vendor_name ?? invoice.file_name ?? "invoice")
    .toLowerCase()
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 60);
  const number = invoice.invoice_number?.trim() || invoice.id.slice(0, 8);
  return `${vendor}.${number}`;
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

// Mirrors InvoiceStatusBadge's Tailwind palette (bg-*-100 / text-*-800) so
// the PDF's status pill matches what the same status looks like in the
// app. Light tint fills only — this report is designed to print cheaply,
// never a solid/dark background.
const STATUS_COLORS: Record<string, { bg: PdfColor; text: PdfColor }> = {
  on_review: { bg: { r: 0.929, g: 0.914, b: 0.996 }, text: { r: 0.357, g: 0.129, b: 0.714 } },
  on_approval: { bg: { r: 0.996, g: 0.953, b: 0.78 }, text: { r: 0.573, g: 0.251, b: 0.055 } },
  approved: { bg: { r: 0.82, g: 0.98, b: 0.898 }, text: { r: 0.024, g: 0.373, b: 0.275 } },
  cancelled: { bg: { r: 0.945, g: 0.961, b: 0.976 }, text: { r: 0.392, g: 0.455, b: 0.545 } },
  rejected: { bg: { r: 0.996, g: 0.886, b: 0.886 }, text: { r: 0.6, g: 0.106, b: 0.106 } },
  on_hold: { bg: { r: 1, g: 0.929, b: 0.835 }, text: { r: 0.604, g: 0.204, b: 0.071 } },
};
const DEFAULT_STATUS_COLOR = STATUS_COLORS.cancelled;

const LIGHT_GRAY: PdfColor = { r: 0.965, g: 0.968, b: 0.973 };
const AMBER_FILL: PdfColor = { r: 0.996, g: 0.961, b: 0.867 };
const AMBER_ACCENT: PdfColor = { r: 0.706, g: 0.325, b: 0.035 };
const RED_FILL: PdfColor = { r: 0.996, g: 0.929, b: 0.929 };
const RED_ACCENT: PdfColor = { r: 0.6, g: 0.106, b: 0.106 };
const EMERALD_TEXT: PdfColor = { r: 0.024, g: 0.373, b: 0.275 };
const RED_TEXT: PdfColor = { r: 0.6, g: 0.106, b: 0.106 };
const TIMELINE_DOT: PdfColor = { r: 0.373, g: 0.404, b: 0.949 }; // indigo-500-ish

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

  const stepIds = steps.map((s) => s.id);
  const { data: stepApproversRaw } =
    stepIds.length > 0
      ? await supabase.from("approval_workflow_step_approvers").select("*").in("step_id", stepIds)
      : { data: [] };
  const approverRowIds = (stepApproversRaw ?? []).map((a) => a.id);
  const { data: stepConditionsRaw } =
    approverRowIds.length > 0
      ? await supabase
          .from("approval_workflow_step_conditions")
          .select("*")
          .in("step_approver_id", approverRowIds)
      : { data: [] };

  const approversByStepId = new Map<string, StepApprover[]>();
  for (const a of stepApproversRaw ?? []) {
    const list = approversByStepId.get(a.step_id) ?? [];
    list.push({ id: a.id, approver_user_id: a.approver_user_id, is_default: a.is_default });
    approversByStepId.set(a.step_id, list);
  }
  const conditionsByApproverId = new Map<string, StepCondition[]>();
  for (const c of stepConditionsRaw ?? []) {
    const list = conditionsByApproverId.get(c.step_approver_id) ?? [];
    list.push({
      step_approver_id: c.step_approver_id,
      field: c.field,
      operator: c.operator,
      match_values: c.match_values,
    });
    conditionsByApproverId.set(c.step_approver_id, list);
  }

  const profileIds = [
    invoice.submitted_by,
    ...(stepApproversRaw ?? []).map((a) => a.approver_user_id),
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

  // Project names for change details (project_id is stored as a UUID — the
  // timeline must show the name, never the raw id).
  const { data: projectRows } = await supabase
    .from("projects")
    .select("id, name")
    .eq("organization_id", invoice.organization_id);
  const projectNameById = new Map((projectRows ?? []).map((p) => [p.id, p.name]));

  const timeline = buildAuditTimeline({
    auditEntries,
    comments,
    nameOf,
    idName: (id) => projectNameById.get(id),
  });

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
  const statusColor = STATUS_COLORS[invoice.status] ?? DEFAULT_STATUS_COLOR;
  const badgeW = textWidth(statusLabel, 8.5, true) + 20;
  lines.push({
    spaceBefore: 10,
    cells: [{ text: statusLabel, x: CONTENT_W - badgeW + 10, size: 8.5, bold: true, color: statusColor.text }],
    box: { x: CONTENT_W - badgeW, width: badgeW, height: 16, fill: statusColor.bg },
  });

  // A single light-tint card holding what used to be two separate blocks
  // (header metadata + the "Invoice" section further down) — a cheap way
  // to get the reference's two-card look out of this engine's sequential
  // row layout: one shared fill box behind label/value rows zipped into
  // two columns.
  const metaRows: [{ label: string; value: string }, { label: string; value: string }][] = [
    [
      { label: "Organization", value: org?.name ?? "Unknown" },
      { label: "Invoice number", value: invoice.invoice_number ?? "—" },
    ],
    [
      { label: "Submitted by", value: nameOf(invoice.submitted_by) },
      { label: "Bill date", value: invoice.bill_date ?? "—" },
    ],
    [
      { label: "Generated", value: new Date().toLocaleDateString() },
      { label: "Due date", value: invoice.due_date ?? "—" },
    ],
  ];
  const gridH = metaRows.length * 36 + 14;
  metaRows.forEach((row, i) => {
    lines.push({
      spaceBefore: i === 0 ? 14 : 12,
      cells: [
        { text: row[0].label.toUpperCase(), x: 14, gray: 0.55, size: 7.5, bold: true },
        { text: row[1].label.toUpperCase(), x: 270, gray: 0.55, size: 7.5, bold: true },
      ],
      box: i === 0 ? { x: 0, width: CONTENT_W, height: gridH, fill: LIGHT_GRAY } : undefined,
    });
    lines.push({
      spaceBefore: 2,
      cells: [
        { text: row[0].value, x: 14, size: 10.5, bold: true, maxWidth: 230 },
        { text: row[1].value, x: 270, size: 10.5, bold: true, maxWidth: 230 },
      ],
    });
  });
  lines.push(rule(20));

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
      const stepApprovers = approversByStepId.get(step.id) ?? [];
      const stepConditions = stepApprovers.flatMap(
        (a) => conditionsByApproverId.get(a.id) ?? []
      );
      const requiredIds = effectiveApproversForStep(
        stepApprovers,
        stepConditions,
        { vendor_name: invoice.vendor_name, project_id: invoice.project_id },
        lineItems.map((li) => ({ class: li.class, category: li.category, project_id: li.project_id }))
      );
      const decisionsForStep = approvals.filter((a) => a.step_order === step.step_order);
      const isOpen =
        step.step_order === invoice.current_step_order &&
        invoice.status !== "approved" &&
        invoice.status !== "rejected" &&
        invoice.status !== "cancelled";

      const rowApproverIds = requiredIds.length > 0 ? requiredIds : [null];
      for (const approverId of rowApproverIds) {
        const decision = decisionsForStep.find((d) => d.approver_id === approverId);
        const state = isOpen ? "Awaiting" : decision ? decision.decision : "Not decided";
        const stateColor =
          state === "approved" ? EMERALD_TEXT : state === "rejected" ? RED_TEXT : undefined;
        lines.push({
          cells: [
            {
              text: approverId ? nameOf(approverId) : "No approver assigned",
              x: 0,
              bold: true,
              size: 10,
              maxWidth: 210,
            },
            { text: step.name || `Step ${step.step_order}`, x: 220, size: 10 },
            {
              text: state.charAt(0).toUpperCase() + state.slice(1),
              x: 340,
              size: 10,
              bold: !!stateColor,
              color: stateColor,
            },
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
  }
  lines.push(rule(14));

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
  lines.push(rule(16), sectionHeader("Instructions for accounting"));
  if (invoice.accounting_instructions) {
    const size = 10;
    const indent = 16;
    const lineH = Math.round(size * 1.35);
    const wrapped = wrapLine(invoice.accounting_instructions, size);
    const boxH = wrapped.length * lineH + 16;
    wrapped.forEach((text, i) => {
      lines.push({
        text,
        size,
        indent,
        spaceBefore: i === 0 ? 10 : 0,
        box: i === 0 ? { x: -indent, width: CONTENT_W, height: boxH, fill: AMBER_FILL } : undefined,
        vline: i === 0 ? { x: -indent, length: boxH - 2, color: AMBER_ACCENT, width: 3 } : undefined,
      });
    });
  } else {
    lines.push({ text: "None.", size: 10, gray: 0.5, spaceBefore: 8 });
  }

  // --- Timeline (audit log + discussion, merged & chronological) -------------------------------------------------
  lines.push(rule(16), sectionHeader("Timeline"));
  if (timeline.length === 0) {
    lines.push({ text: "No activity recorded.", size: 10, spaceBefore: 8 });
  } else {
    const dotR = 3;
    const dotX = 2;
    timeline.forEach((entry, i) => {
      const actorW = Math.min(textWidth(entry.actorName, 9.5, true), 140);
      const summaryX = actorW + 15;
      const hasDetail = !!entry.detail;
      // Each entry's rail segment reaches down to where the NEXT entry's
      // dot sits, so consecutive segments chain into one continuous line
      // without needing cross-entry pixel knowledge. The last entry omits
      // the trailing segment (nothing to connect to).
      const segmentLength = i < timeline.length - 1 ? (hasDetail ? 13 + 24 : 13) + 9 : 0;
      lines.push({
        indent: 16,
        cells: [
          { text: entry.actorName, x: 0, bold: true, size: 9.5, maxWidth: 135 },
          {
            text: entry.kind === "comment" ? "commented" : entry.summary,
            x: summaryX,
            size: 9.5,
            maxWidth: CONTENT_W - 110 - summaryX,
          },
          { text: fmtDate(entry.at), x: CONTENT_W - 16, align: "right", size: 8, gray: 0.5 },
        ],
        spaceBefore: 9,
        dot: { x: -dotX - 13, radius: dotR, color: TIMELINE_DOT },
        vline: segmentLength > 0 ? { x: -dotX - 13, length: segmentLength, color: TIMELINE_DOT, width: 1.5 } : undefined,
      });
      if (entry.detail) {
        lines.push({ text: entry.detail, size: 9, gray: 0.45, indent: 24 });
      }
    });
  }

  // --- Conditional note when the status was manually overridden ---------
  if (auditEntries.some((e) => e.action === "invoice.admin_override_status")) {
    const noteText =
      "Note for reviewers: This invoice's status was changed manually by an admin, outside the normal approval flow. Please review the timeline above before relying on the approval log alone.";
    const size = 9.5;
    const indent = 16;
    const lineH = Math.round(size * 1.35);
    const wrapped = wrapLine(noteText, size);
    const boxH = wrapped.length * lineH + 16;
    wrapped.forEach((text, i) => {
      lines.push({
        text,
        size,
        indent,
        spaceBefore: i === 0 ? 20 : 0,
        box: i === 0 ? { x: -indent, width: CONTENT_W, height: boxH, fill: RED_FILL } : undefined,
        vline: i === 0 ? { x: -indent, length: boxH - 2, color: RED_ACCENT, width: 3 } : undefined,
      });
    });
  }

  return {
    filename: `audit-trail-${invoiceFileBase(invoice)}.pdf`,
    pdf: buildPdf(lines),
  };
}
