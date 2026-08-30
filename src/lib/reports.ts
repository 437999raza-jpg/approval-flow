import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { computeWaitingForIds } from "@/lib/workflow-waiting";

// Report runner: executes a saved report config against the caller's
// visible invoices (RLS scopes the query, so admins see everything and
// members only their workflow-covered projects). Authored by Araza.

export interface ReportFilters {
  status?: string;
  vendor?: string; // case-insensitive contains
  project_id?: string;
  amount_over?: number;
  amount_under?: number;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  // "Waiting for" / "Approved by" aren't plain invoice columns — matching
  // needs per-invoice workflow-step resolution (waiting for) or a join
  // against invoice_approvals (approved by), so both are applied
  // separately (see computeWaitingForIds/workflow-waiting.ts and
  // computeApprovedByIds below) rather than inside
  // filterInvoicesForReport.
  waiting_for_user_id?: string;
  approved_by_user_id?: string;
  submitted_by_user_id?: string;
}

export interface ReportConfig {
  metric: "count" | "amount" | "tax";
  groupBy: "none" | "month" | "vendor" | "status" | "project";
  filters: ReportFilters;
  // Which optional columns the invoice-list report/CSV shows, by id (see
  // REPORT_COLUMNS in invoice-list-report.ts — not imported here to avoid
  // a circular import, since that module already imports ReportFilters
  // from this one). Undefined (a report saved before this feature
  // existed) means "use DEFAULT_REPORT_COLUMNS", not "show nothing".
  columns?: string[];
}

export interface ReportRow {
  key: string;
  count: number;
  amount: number;
  tax: number;
}

export interface ReportResult {
  rows: ReportRow[];
  totals: ReportRow;
  metric: ReportConfig["metric"];
  groupBy: ReportConfig["groupBy"];
}

// Shared by runReport (grouped counts/sums) and the invoice-list export
// (individual rows, sorted by customer then supplier) — same filter
// semantics for both, so "filter, then either summarize or list" stays
// consistent no matter which view someone's looking at.
//
// project_id is deliberately NOT checked here, unlike every other filter
// — a bill can split across multiple projects via invoice_line_items
// (migration 0019), not just the single invoices.project_id column, so
// matching it needs per-invoice line-item data this generic function
// doesn't have. Same reason waiting_for_user_id/approved_by_user_id are
// applied as a separate post-filter step by each caller instead of living
// in here — see computeProjectIdsByInvoice below.
export function filterInvoicesForReport<
  T extends {
    status: string;
    vendor_name: string | null;
    project_id: string | null;
    amount: number | null;
    tax_amount: number | null;
    submitted_by: string | null;
    created_at: string;
  },
>(invoices: T[], f: ReportFilters): T[] {
  const fromMs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toMs = f.to ? new Date(`${f.to}T23:59:59`).getTime() : null;

  return invoices.filter((i) => {
    if (f.status && i.status !== f.status) return false;
    if (
      f.vendor &&
      !(i.vendor_name ?? "").toLowerCase().includes(f.vendor.toLowerCase())
    ) {
      return false;
    }
    if (f.amount_over != null && (i.amount ?? 0) < f.amount_over) return false;
    if (f.amount_under != null && (i.amount ?? 0) > f.amount_under) return false;
    if (f.submitted_by_user_id && i.submitted_by !== f.submitted_by_user_id) return false;
    const created = new Date(i.created_at).getTime();
    if (fromMs != null && created < fromMs) return false;
    if (toMs != null && created > toMs) return false;
    return true;
  });
}

// Every project an invoice touches — the invoice's own project_id (old
// data, or a simple single-project bill) UNION every line item's
// project_id (a bill split across several — migration 0019). Shared by
// runReport (which has no other reason to fetch line items) so both the
// project filter and "group by project" see the same real picture
// invoice-list-report.ts's own per-row "Customers" column already does.
export async function computeProjectIdsByInvoice(
  supabase: SupabaseClient<Database>,
  invoices: { id: string; project_id: string | null }[]
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  for (const i of invoices) {
    if (i.project_id) map.set(i.id, new Set([i.project_id]));
  }
  if (invoices.length === 0) return map;
  const { data: lineItems } = await supabase
    .from("invoice_line_items")
    .select("invoice_id, project_id")
    .in(
      "invoice_id",
      invoices.map((i) => i.id)
    );
  for (const li of lineItems ?? []) {
    if (!li.project_id) continue;
    const set = map.get(li.invoice_id) ?? new Set<string>();
    set.add(li.project_id);
    map.set(li.invoice_id, set);
  }
  return map;
}

// Who actually approved each invoice (decision = 'approved' rows in
// invoice_approvals) — a plain join, unlike "waiting for" which needs
// live workflow-step resolution. Shared by runReport and
// buildInvoiceListReport so both compute this the same way.
export async function computeApprovedByIds(
  supabase: SupabaseClient<Database>,
  invoiceIds: string[]
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (invoiceIds.length === 0) return map;
  const { data: approvals } = await supabase
    .from("invoice_approvals")
    .select("invoice_id, approver_id")
    .in("invoice_id", invoiceIds)
    .eq("decision", "approved");
  for (const a of approvals ?? []) {
    if (!a.approver_id) continue;
    const set = map.get(a.invoice_id) ?? new Set<string>();
    set.add(a.approver_id);
    map.set(a.invoice_id, set);
  }
  return map;
}

export async function runReport(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  config: ReportConfig
): Promise<ReportResult> {
  const { data: invoices } = await supabase
    .from("invoices")
    .select(
      "id, status, vendor_name, project_id, amount, tax_amount, submitted_by, created_at, workflow_id, current_step_order, step_override_approver_id"
    )
    .eq("organization_id", organizationId);

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name")
    .eq("organization_id", organizationId);
  const projectName = new Map(
    (projects ?? []).map((p) => [p.id, p.name])
  );

  let list = filterInvoicesForReport(invoices ?? [], config.filters);

  // "Waiting for" isn't a plain invoice column — needs the same per-
  // invoice workflow-step resolution the invoice-list report uses for its
  // own "Waiting for" column, so a saved report scoped to one approver
  // (e.g. "Bianca") narrows the summary the same way it narrows the list.
  if (config.filters.waiting_for_user_id) {
    const wantedId = config.filters.waiting_for_user_id;
    const waitingIdsByInvoice = await computeWaitingForIds(supabase, list);
    list = list.filter((i) => (waitingIdsByInvoice.get(i.id) ?? []).includes(wantedId));
  }
  if (config.filters.approved_by_user_id) {
    const wantedId = config.filters.approved_by_user_id;
    const approvedIdsByInvoice = await computeApprovedByIds(supabase, list.map((i) => i.id));
    list = list.filter((i) => approvedIdsByInvoice.get(i.id)?.has(wantedId));
  }

  // Needed either way "project" comes up: to filter by it (a bill split
  // across several projects should match a filter on any of them, not
  // just whichever one sits on the invoice row) and to group by it below.
  const projectIdsByInvoice = await computeProjectIdsByInvoice(supabase, list);
  if (config.filters.project_id) {
    const wantedId = config.filters.project_id;
    list = list.filter((i) => projectIdsByInvoice.get(i.id)?.has(wantedId));
  }

  const keyOf = (i: (typeof list)[number]): string => {
    switch (config.groupBy) {
      case "month":
        return i.created_at.slice(0, 7); // YYYY-MM
      case "vendor":
        return i.vendor_name ?? "Unknown";
      case "status":
        return i.status;
      default:
        return "All";
    }
  };

  const rows = new Map<string, ReportRow>();
  const totals: ReportRow = { key: "Total", count: 0, amount: 0, tax: 0 };

  for (const i of list) {
    // A split invoice contributes to EVERY project it touches (the
    // standard way a split bill gets attributed in a real accounting
    // report), not just whichever project happens to sit on the invoice
    // row — but only ever counts ONCE toward the totals below.
    const keys =
      config.groupBy === "project"
        ? (() => {
            const ids = projectIdsByInvoice.get(i.id);
            return ids && ids.size > 0
              ? [...ids].map((pid) => projectName.get(pid) ?? "Unknown")
              : ["No project"];
          })()
        : [keyOf(i)];

    for (const key of keys) {
      const row = rows.get(key) ?? { key, count: 0, amount: 0, tax: 0 };
      row.count += 1;
      row.amount += i.amount ?? 0;
      row.tax += i.tax_amount ?? 0;
      rows.set(key, row);
    }

    totals.count += 1;
    totals.amount += i.amount ?? 0;
    totals.tax += i.tax_amount ?? 0;
  }

  return {
    rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    totals,
    metric: config.metric,
    groupBy: config.groupBy,
  };
}
