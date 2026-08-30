import { Fragment } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
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
// documents, status overrides, discussion). Card-based layout (rounded
// corners, colored pills, a light page background) built with
// @react-pdf/renderer — a React-like PDF renderer, not a browser
// screenshot, so it works in a normal serverless function with no
// headless-Chromium dependency. This is ONE of the two files attached to
// the bill when the invoice syncs to QuickBooks — the other is the
// original invoice document. Authored by Araza.
//
// Deliberately no decorative icons/emoji: react-pdf can only place them by
// fetching each glyph as an image from an external CDN at render time
// (Font.registerEmojiSource), and this document also feeds the QBO sync
// attachment — a flaky third-party fetch has no business being a point of
// failure there. The colored pills/badges carry the same "read at a
// glance" job emoji would have.

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
// app.
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  on_review: { bg: "#ede9fe", text: "#5b21b6" },
  on_approval: { bg: "#fef3c7", text: "#92400e" },
  approved: { bg: "#d1fae5", text: "#065f46" },
  cancelled: { bg: "#f1f5f9", text: "#64748b" },
  rejected: { bg: "#fee2e2", text: "#991b1b" },
  on_hold: { bg: "#ffedd5", text: "#9a3412" },
};
const DEFAULT_STATUS_COLOR = STATUS_COLORS.cancelled;

// Approval-log decision pills — every state gets a filled badge, not just
// approved/rejected, so "Awaiting" and "Not decided" read at a glance
// instead of blending into plain body text.
const DECISION_COLORS: Record<string, { bg: string; text: string }> = {
  awaiting: { bg: "#fef3c7", text: "#b45309" },
  "not decided": { bg: "#f3f4f6", text: "#6b7280" },
  approved: STATUS_COLORS.approved,
  rejected: STATUS_COLORS.rejected,
};

const INK = "#111827";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";
const BORDER = "#e5e7eb";
const PAGE_BG = "#f9fafb";
const AMBER_FILL = "#fef3c7";
const AMBER_ACCENT = "#b45309";
const RED_FILL = "#fee2e2";
const RED_ACCENT = "#991b1b";
const TIMELINE_DOT = "#5f67f2";

const styles = StyleSheet.create({
  page: { backgroundColor: PAGE_BG, padding: 28, fontSize: 9, color: INK, fontFamily: "Helvetica" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 14 },
  billFrom: { fontSize: 9, color: MUTED, marginBottom: 3 },
  billTitle: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  amount: { fontSize: 18, fontFamily: "Helvetica-Bold", textAlign: "right" },
  badge: {
    alignSelf: "flex-end",
    marginTop: 6,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 999,
  },
  badgeText: { fontSize: 7.5, fontFamily: "Helvetica-Bold", letterSpacing: 0.5 },
  card: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 8,
    padding: 14,
    marginBottom: 11,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    marginBottom: 9,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  detailsGrid: { flexDirection: "row" },
  detailsCol: { flex: 1 },
  detailRow: { marginBottom: 8 },
  detailLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", color: FAINT, letterSpacing: 0.5, marginBottom: 2 },
  detailValue: { fontSize: 10, fontFamily: "Helvetica-Bold" },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    paddingBottom: 5,
    marginBottom: 6,
  },
  th: { fontSize: 7, fontFamily: "Helvetica-Bold", color: FAINT, letterSpacing: 0.5 },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    paddingVertical: 6,
  },
  tableRowLast: { flexDirection: "row", paddingVertical: 6 },
  td: { fontSize: 9 },
  pill: { alignSelf: "flex-start", paddingVertical: 2, paddingHorizontal: 7, borderRadius: 999 },
  pillText: { fontSize: 8, fontFamily: "Helvetica-Bold" },
  totalsWrap: { alignItems: "flex-end", marginTop: 10 },
  totalsBlock: { minWidth: 180 },
  totalsRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  totalsLabel: { fontSize: 9, color: MUTED },
  totalsValue: { fontSize: 9 },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 2,
    borderTopColor: INK,
    marginTop: 5,
    paddingTop: 7,
  },
  grandLabel: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  grandValue: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  note: {
    backgroundColor: PAGE_BG,
    borderLeftWidth: 3,
    borderLeftColor: "#d1d5db",
    padding: 9,
    fontSize: 9,
    color: MUTED,
    fontStyle: "italic",
  },
  noteAccent: { padding: 9, fontSize: 9 },
  timelineRow: { flexDirection: "row", marginBottom: 10 },
  timelineDotCol: { width: 16, alignItems: "center", paddingTop: 3 },
  // react-pdf Views default to flexDirection "row" (unlike web/React
  // Native's "column" default) — without this explicit override, the
  // title+date row and the description line below it become row-siblings
  // and render on top of each other instead of stacking.
  timelineBody: { flex: 1, flexDirection: "column" },
  timelineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: TIMELINE_DOT },
  timelineContent: { flex: 1, flexDirection: "row", justifyContent: "space-between" },
  timelineTitle: { fontSize: 9.5, fontFamily: "Helvetica-Bold" },
  timelineDesc: { fontSize: 9, color: MUTED, marginTop: 1 },
  timelineDetail: { fontSize: 8.5, color: "#9ca3af", marginTop: 2 },
  timelineDate: { fontSize: 8, color: FAINT, flexShrink: 0, marginLeft: 8 },
  reviewerNote: {
    backgroundColor: RED_FILL,
    borderLeftWidth: 3,
    borderLeftColor: RED_ACCENT,
    padding: 9,
    fontSize: 8.5,
    marginTop: 6,
  },
});

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card} wrap={false}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
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

  // The PDF is built server-side, where there's no browser to default to
  // the viewer's local time — toLocaleString() without an explicit
  // timeZone falls back to the SERVER's zone (UTC on Vercel), showing
  // times hours ahead of what the same timestamp renders as in the app
  // itself (client-rendered, so it naturally uses the browser's zone).
  // No org-level timezone setting exists yet, and every project/address
  // in this app is Ontario-based, so hardcode Eastern for now.
  const TZ = "America/Toronto";
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      timeZone: TZ,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const fmtAmount = (n: number | null) =>
    n != null ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

  const statusLabel = STATUS_LABELS[invoice.status] ?? invoice.status.toUpperCase();
  const statusColor = STATUS_COLORS[invoice.status] ?? DEFAULT_STATUS_COLOR;

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
      { label: "Generated", value: new Date().toLocaleDateString(undefined, { timeZone: TZ }) },
      { label: "Due date", value: invoice.due_date ?? "—" },
    ],
  ];

  const subtotal =
    invoice.amount != null && invoice.tax_amount != null ? invoice.amount - invoice.tax_amount : null;

  const hasOverride = auditEntries.some((e) => e.action === "invoice.admin_override_status");

  const doc = (
    <Document>
      <Page size="LETTER" style={styles.page} wrap>
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.billFrom}>
              Bill from {invoice.vendor_name ?? invoice.file_name}
            </Text>
            <Text style={styles.billTitle}>Invoice {invoice.invoice_number ?? "—"}</Text>
          </View>
          <View>
            <Text style={styles.amount}>
              {fmtAmount(invoice.amount)} {invoice.currency}
            </Text>
            <View style={[styles.badge, { backgroundColor: statusColor.bg }]}>
              <Text style={[styles.badgeText, { color: statusColor.text }]}>{statusLabel}</Text>
            </View>
          </View>
        </View>

        {/* Bill details */}
        <Card title="Bill details">
          <View style={styles.detailsGrid}>
            <View style={styles.detailsCol}>
              {metaRows.map((row, i) => (
                <View key={i} style={styles.detailRow}>
                  <Text style={styles.detailLabel}>{row[0].label.toUpperCase()}</Text>
                  <Text style={styles.detailValue}>{row[0].value}</Text>
                </View>
              ))}
            </View>
            <View style={styles.detailsCol}>
              {metaRows.map((row, i) => (
                <View key={i} style={styles.detailRow}>
                  <Text style={styles.detailLabel}>{row[1].label.toUpperCase()}</Text>
                  <Text style={styles.detailValue}>{row[1].value}</Text>
                </View>
              ))}
            </View>
          </View>
        </Card>

        {/* Approval log */}
        <Card title="Approval log">
          {steps.length === 0 ? (
            <Text style={{ fontSize: 9.5, color: MUTED }}>No approval workflow assigned.</Text>
          ) : (
            <>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.th, { flex: 0.34 }]}>NAME</Text>
                <Text style={[styles.th, { flex: 0.26 }]}>STEP</Text>
                <Text style={[styles.th, { flex: 0.2 }]}>DECISION</Text>
                <Text style={[styles.th, { flex: 0.2, textAlign: "right" }]}>DATE / TIME</Text>
              </View>
              {steps.map((step) => {
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

                return rowApproverIds.map((approverId, i) => {
                  const decision = decisionsForStep.find((d) => d.approver_id === approverId);
                  const state = isOpen ? "Awaiting" : decision ? decision.decision : "Not decided";
                  const stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
                  const pillColors = DECISION_COLORS[state.toLowerCase()] ?? DECISION_COLORS["not decided"];
                  const isLast = step === steps[steps.length - 1] && i === rowApproverIds.length - 1;
                  return (
                    <Fragment key={`${step.id}-${approverId ?? "none"}`}>
                      <View style={isLast ? styles.tableRowLast : styles.tableRow}>
                        <Text style={[styles.td, { flex: 0.34, fontFamily: "Helvetica-Bold", paddingRight: 6 }]}>
                          {approverId ? nameOf(approverId) : "No approver assigned"}
                        </Text>
                        <Text style={[styles.td, { flex: 0.26, paddingRight: 6 }]}>
                          {step.name || `Step ${step.step_order}`}
                        </Text>
                        <View style={{ flex: 0.2 }}>
                          <View style={[styles.pill, { backgroundColor: pillColors.bg }]}>
                            <Text style={[styles.pillText, { color: pillColors.text }]}>{stateLabel}</Text>
                          </View>
                        </View>
                        <Text style={[styles.td, { flex: 0.2, textAlign: "right", color: MUTED }]}>
                          {decision
                            ? new Date(decision.decided_at).toLocaleDateString(undefined, { timeZone: TZ })
                            : "—"}
                        </Text>
                      </View>
                      {decision?.comment && (
                        <Text style={{ fontSize: 8.5, color: MUTED, fontStyle: "italic", marginTop: -3, marginBottom: 4 }}>
                          {`"${decision.comment}"`}
                        </Text>
                      )}
                    </Fragment>
                  );
                });
              })}
            </>
          )}
        </Card>

        {/* Line items */}
        <Card title={`Line items (${lineItems.length})`}>
          {lineItems.length === 0 ? (
            <Text style={{ fontSize: 9.5, color: MUTED }}>No line items.</Text>
          ) : (
            <>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.th, { flex: 0.21, paddingRight: 6 }]}>CATEGORY</Text>
                <Text style={[styles.th, { flex: 0.36, paddingRight: 6 }]}>DESCRIPTION</Text>
                <Text style={[styles.th, { flex: 0.1, textAlign: "right", paddingRight: 10 }]}>TAX %</Text>
                <Text style={[styles.th, { flex: 0.15, paddingRight: 6 }]}>CLASS</Text>
                <Text style={[styles.th, { flex: 0.18, textAlign: "right" }]}>AMOUNT</Text>
              </View>
              {lineItems.map((item, i) => (
                <View key={item.id} style={i === lineItems.length - 1 ? styles.tableRowLast : styles.tableRow}>
                  <Text style={[styles.td, { flex: 0.21, paddingRight: 6 }]}>{item.category ?? "—"}</Text>
                  <Text style={[styles.td, { flex: 0.36, paddingRight: 6 }]}>{item.description ?? "—"}</Text>
                  <Text style={[styles.td, { flex: 0.1, textAlign: "right", paddingRight: 10 }]}>
                    {item.tax_rate != null ? `${item.tax_rate}%` : "—"}
                  </Text>
                  <Text style={[styles.td, { flex: 0.15, paddingRight: 6 }]}>{item.class ?? "—"}</Text>
                  <Text style={[styles.td, { flex: 0.18, textAlign: "right", fontFamily: "Helvetica-Bold" }]}>
                    {fmtAmount(item.amount)}
                  </Text>
                </View>
              ))}
            </>
          )}
          <View style={styles.totalsWrap}>
            <View style={styles.totalsBlock}>
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>Subtotal</Text>
                <Text style={styles.totalsValue}>{fmtAmount(subtotal)}</Text>
              </View>
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>Tax</Text>
                <Text style={styles.totalsValue}>{fmtAmount(invoice.tax_amount)}</Text>
              </View>
              <View style={styles.grandRow}>
                <Text style={styles.grandLabel}>Total</Text>
                <Text style={styles.grandValue}>
                  {fmtAmount(invoice.amount)} {invoice.currency}
                </Text>
              </View>
            </View>
          </View>
        </Card>

        {/* Instructions for accounting */}
        <Card title="Instructions for accounting">
          {invoice.accounting_instructions ? (
            <View style={[styles.noteAccent, { backgroundColor: AMBER_FILL, borderLeftWidth: 3, borderLeftColor: AMBER_ACCENT }]}>
              <Text>{invoice.accounting_instructions}</Text>
            </View>
          ) : (
            <View style={styles.note}>
              <Text>None.</Text>
            </View>
          )}
        </Card>

        {/* Timeline */}
        <Card title="Timeline">
          {timeline.length === 0 ? (
            <Text style={{ fontSize: 9.5, color: MUTED }}>No activity recorded.</Text>
          ) : (
            timeline.map((entry, i) => (
              <View key={i} style={styles.timelineRow} wrap={false}>
                <View style={styles.timelineDotCol}>
                  <View style={styles.timelineDot} />
                </View>
                <View style={styles.timelineBody}>
                  <View style={styles.timelineContent}>
                    <Text style={styles.timelineTitle}>{entry.actorName}</Text>
                    <Text style={styles.timelineDate}>{fmtDate(entry.at)}</Text>
                  </View>
                  <Text style={styles.timelineDesc}>
                    {entry.kind === "comment" ? "commented" : entry.summary}
                  </Text>
                  {entry.detail && <Text style={styles.timelineDetail}>{entry.detail}</Text>}
                </View>
              </View>
            ))
          )}
        </Card>

        {hasOverride && (
          <View style={styles.reviewerNote} wrap={false}>
            <Text>
              {"Note for reviewers: This invoice's status was changed manually by an admin, outside " +
                "the normal approval flow. Please review the timeline above before relying on the " +
                "approval log alone."}
            </Text>
          </View>
        )}
      </Page>
    </Document>
  );

  const pdf = await renderToBuffer(doc);

  return {
    filename: `audit-trail-${invoiceFileBase(invoice)}.pdf`,
    pdf,
  };
}
