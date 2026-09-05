// Turns the raw audit_log rows + discussion comments for one invoice into
// a single, human-readable, chronological timeline — "everything that
// happened on this invoice" in one story instead of separate disjoint
// sections. Shared by the in-app Audit trail view and the downloadable
// PDF (src/lib/audit-trail.ts) so the two never drift apart.
// Authored by Araza.

export interface AuditTimelineEntry {
  id: string;
  at: string; // ISO timestamp
  kind: "event" | "comment";
  actorName: string;
  summary: string;
  detail?: string;
}

// Optional resolver for ids stored in change metadata (e.g. project_id is
// a UUID — show the project name, not the raw id).
export type IdNameResolver = (id: string) => string | undefined;

interface RawAuditRow {
  id: string;
  created_at: string;
  action: string;
  actor_id: string | null;
  metadata: unknown;
}

interface RawComment {
  id: string;
  created_at: string;
  author_id: string | null;
  body: string;
}

function meta(m: unknown): Record<string, unknown> {
  return m && typeof m === "object" ? (m as Record<string, unknown>) : {};
}

const FIELD_LABELS: Record<string, string> = {
  vendor_name: "Vendor name",
  source_email: "Email",
  invoice_number: "Bill number",
  bill_date: "Bill date",
  due_date: "Due date",
  currency: "Currency",
  description: "Description",
  category: "Category",
  class: "Class",
  project_id: "Project",
  tax_rate: "Tax %",
  amount: "Amount",
  linked: "Linked",
};

function describeBillFieldChanges(
  m: Record<string, unknown>,
  idName?: IdNameResolver
): string | undefined {
  const changes = m.changes;
  if (!changes || typeof changes !== "object") return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { from, to } = value as { from: unknown; to: unknown };
    const label = FIELD_LABELS[key] ?? key;
    const fmt = (v: unknown) => {
      if (v == null || v === "") return "—";
      if (typeof v === "string" && idName) return idName(v) ?? v;
      return String(v);
    };
    parts.push(`${label}: "${fmt(from)}" → "${fmt(to)}"`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// action -> (metadata, idName) => { summary, detail? }
const ACTION_DESCRIBERS: Record<
  string,
  (m: Record<string, unknown>, idName?: IdNameResolver) => { summary: string; detail?: string }
> = {
  "invoice.uploaded": () => ({ summary: "Invoice uploaded" }),
  "invoice.received_by_email": (m) => ({
    summary: "Invoice received by email",
    detail: typeof m.source_email === "string" ? `From ${m.source_email}` : undefined,
  }),
  "invoice.review_done": () => ({ summary: "Review completed — sent into the approval workflow" }),
  "invoice.held": () => ({ summary: "Put on hold" }),
  "invoice.back_to_review": () => ({ summary: "Sent back to review" }),
  "invoice.cancelled": () => ({ summary: "Cancelled" }),
  "invoice.deleted": (m) => ({
    summary: "Invoice deleted",
    detail:
      m.vendor_name || m.invoice_number
        ? `${m.vendor_name ?? "—"}${m.invoice_number ? ` #${m.invoice_number}` : ""}`
        : undefined,
  }),
  "invoice.reassigned": () => ({ summary: "Reassigned to a different approver" }),
  "invoice.admin_override_status": (m) => ({
    summary: "Status manually overridden",
    detail: m.from && m.to ? `${m.from} → ${m.to}` : undefined,
  }),
  "invoice.re_extracted": () => ({ summary: "Document fields re-extracted" }),
  "invoice.approved": () => ({ summary: "Approved" }),
  "invoice.rejected": () => ({ summary: "Rejected" }),
  "invoice.bill_fields_edited": (m) => ({
    summary: "Bill fields edited",
    detail: describeBillFieldChanges(m),
  }),  "invoice.document_added": (m) => ({
    summary: "Document attached",
    detail: typeof m.file_name === "string" ? m.file_name : undefined,
  }),
  "invoice.backup_docs_merged": (m) => ({
    summary: "Backup documents merged in",
    detail: Array.isArray(m.files) ? m.files.join(", ") : undefined,
  }),
  "invoice.accounting_instructions_edited": (m) => ({
    summary: "Instructions for accounting updated",
    detail: typeof m.instructions === "string" && m.instructions ? `"${m.instructions}"` : "Cleared",
  }),
  "invoice.line_item_added": (m) => ({
    summary: "Line item added",
    detail: typeof m.description === "string" && m.description ? m.description : undefined,
  }),
  "invoice.line_item_edited": (m, idName) => ({
    summary: "Line item edited",
    // New format records exact field changes (from → to). Older entries only
    // carried the description — keep showing that as the detail.
    detail:
      describeBillFieldChanges(m, idName) ??
      (typeof m.description === "string" && m.description ? m.description : undefined),
  }),
  "invoice.line_item_deleted": (m) => ({
    summary: "Line item removed",
    detail: typeof m.description === "string" && m.description ? m.description : undefined,
  }),
  "supplier_defaults.saved": (m) => ({
    summary: "Supplier rule saved",
    detail: typeof m.vendor_name === "string" ? `For ${m.vendor_name}` : undefined,
  }),
  "invoice.qbo_synced": () => ({ summary: "Pushed to QBO" }),
  "invoice.qbo_sync_failed": (m) => ({
    summary: "Push to QBO failed",
    detail: typeof m.error === "string" ? m.error : undefined,
  }),
  "invoice.qbo_sync_cleared": () => ({ summary: "QBO sync cleared — ready to push again" }),
  // Bulk historical import (migration 0104/0120) — distinct from
  // invoice.qbo_synced above: this bill already existed in QBO, Flow
  // never pushed it. Keeping the two summaries visibly different is the
  // whole point — collapsing them into one generic label is exactly
  // what made "pushed" and "imported" indistinguishable in the trail.
  "invoice.imported_from_qbo": () => ({ summary: "Imported from QBO" }),
};

// Any word "qbo" in the generic fallback below must always render as the
// acronym QBO, never title-cased to "Qbo" — this only matters for action
// codes not covered by an explicit describer above.
function fixQboCasing(s: string): string {
  return s.replace(/\bqbo\b/gi, "QBO");
}

function describeAction(
  action: string,
  metadata: unknown,
  idName?: IdNameResolver
): { summary: string; detail?: string } {
  const m = meta(metadata);
  const describer = ACTION_DESCRIBERS[action];
  if (describer) return describer(m, idName);
  // Fallback for any action not in the map above: turn "invoice.foo_bar"
  // into "Foo bar" rather than silently dropping it from the trail.
  const readable = action.replace(/^invoice\./, "").replace(/_/g, " ");
  const capitalized = readable.charAt(0).toUpperCase() + readable.slice(1);
  return { summary: fixQboCasing(capitalized) };
}

export function buildAuditTimeline({
  auditEntries,
  comments,
  nameOf,
  idName,
}: {
  auditEntries: RawAuditRow[];
  comments: RawComment[];
  nameOf: (id: string | null) => string;
  // Resolve ids stored in change metadata to display names (e.g.
  // project_id UUID → project name) so no raw ids leak into the trail.
  idName?: IdNameResolver;
}): AuditTimelineEntry[] {
  const events: AuditTimelineEntry[] = auditEntries.map((entry) => {
    const { summary, detail } = describeAction(entry.action, entry.metadata, idName);
    return {
      id: entry.id,
      at: entry.created_at,
      kind: "event",
      actorName: nameOf(entry.actor_id),
      summary,
      detail,
    };
  });

  const commentEntries: AuditTimelineEntry[] = comments.map((c) => ({
    id: c.id,
    at: c.created_at,
    kind: "comment",
    actorName: nameOf(c.author_id),
    summary: "Commented",
    detail: c.body,
  }));

  // Newest first — the same convention as every other list in the app
  // (Invoices, Discussion), and what someone checking "what just happened"
  // actually wants without scrolling to the bottom.
  return [...events, ...commentEntries].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );
}
