import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { filterInvoicesForReport, computeApprovedByIds, type ReportFilters } from "@/lib/reports";
import { computeWaitingForIds } from "@/lib/workflow-waiting";

// Per-invoice list, the ApprovalMax-style "Request reports" download —
// unlike runReport (grouped counts/sums), this is one row per invoice,
// sorted by customer then supplier, meant to be read as a list or
// exported as-is. Authored by Araza.

// Every optional column a report can show, beyond Name (always shown —
// it's the link to the invoice). Picked via the builder form's "Visible
// columns" checkboxes (mirrors ApprovalMax's own report editor) and
// stored on ReportConfig.columns; DEFAULT_REPORT_COLUMNS is what a saved
// report from before this feature existed (config.columns undefined)
// falls back to, so old reports keep showing exactly what they always
// did.
export const REPORT_COLUMNS = [
  { id: "amount", label: "Amount" },
  { id: "supplier", label: "Supplier" },
  { id: "status", label: "Status" },
  { id: "approvedBy", label: "Approved by" },
  { id: "waitingFor", label: "Waiting for" },
  { id: "createdAt", label: "Created" },
  { id: "customers", label: "Customers" },
  { id: "age", label: "Age" },
  { id: "queueTime", label: "Time in queue" },
] as const;
export type ReportColumnId = (typeof REPORT_COLUMNS)[number]["id"];
export const DEFAULT_REPORT_COLUMNS: ReportColumnId[] = [
  "amount",
  "supplier",
  "status",
  "approvedBy",
  "waitingFor",
  "createdAt",
  "customers",
];

const DAY_MS = 24 * 60 * 60 * 1000;
// A "queue" only means something while the bill is actually sitting with
// someone waiting on a decision — once it's approved/rejected/cancelled
// there's no one left to be waiting on it, and on_review hasn't entered
// the approval workflow (and its current_step_entered_at) yet.
const QUEUED_STATUSES = new Set(["on_approval", "on_hold"]);

export interface InvoiceListRow {
  id: string;
  name: string;
  amount: number | null;
  supplier: string;
  status: string;
  approvedBy: string;
  waitingFor: string;
  createdAt: string;
  customers: string;
  ageDays: number;
  queueDays: number | null;
}

export async function buildInvoiceListReport(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  filters: ReportFilters
): Promise<InvoiceListRow[]> {
  const { data: invoicesRaw } = await supabase
    .from("invoices")
    .select(
      "id, vendor_name, invoice_number, file_name, amount, tax_amount, submitted_by, status, created_at, current_step_entered_at, project_id, workflow_id, current_step_order, step_override_approver_id"
    )
    .eq("organization_id", organizationId);
  let invoices = filterInvoicesForReport(invoicesRaw ?? [], filters);
  if (invoices.length === 0) return [];

  const invoiceIds = invoices.map((i) => i.id);

  const [{ data: lineItems }, approvedIdsByInvoice, { data: projects }] =
    await Promise.all([
      supabase
        .from("invoice_line_items")
        .select("invoice_id, project_id")
        .in("invoice_id", invoiceIds),
      computeApprovedByIds(supabase, invoiceIds),
      supabase.from("projects").select("id, name").eq("organization_id", organizationId),
    ]);

  const projectName = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const lineItemsByInvoice = new Map<string, { project_id: string | null }[]>();
  for (const li of lineItems ?? []) {
    const list = lineItemsByInvoice.get(li.invoice_id) ?? [];
    list.push({ project_id: li.project_id });
    lineItemsByInvoice.set(li.invoice_id, list);
  }

  // Every project each invoice touches (its own project_id UNION every
  // line item's) — built from the line items already fetched above rather
  // than a second query. filterInvoicesForReport no longer checks
  // project_id itself (a split bill should match a filter on ANY project
  // it touches, which needs this per-invoice data it doesn't have), so
  // this is applied here explicitly, same as waiting_for/approved_by
  // below.
  const projectIdsByInvoice = new Map<string, Set<string>>();
  for (const inv of invoices) {
    const ids = new Set<string>();
    if (inv.project_id) ids.add(inv.project_id);
    for (const li of lineItemsByInvoice.get(inv.id) ?? []) {
      if (li.project_id) ids.add(li.project_id);
    }
    projectIdsByInvoice.set(inv.id, ids);
  }
  if (filters.project_id) {
    const wantedId = filters.project_id;
    invoices = invoices.filter((inv) => projectIdsByInvoice.get(inv.id)?.has(wantedId));
    if (invoices.length === 0) return [];
  }

  const waitingIdsByInvoice = await computeWaitingForIds(supabase, invoices);

  if (filters.waiting_for_user_id) {
    const wantedId = filters.waiting_for_user_id;
    invoices = invoices.filter((inv) =>
      (waitingIdsByInvoice.get(inv.id) ?? []).includes(wantedId)
    );
    if (invoices.length === 0) return [];
  }
  if (filters.approved_by_user_id) {
    const wantedId = filters.approved_by_user_id;
    invoices = invoices.filter((inv) => approvedIdsByInvoice.get(inv.id)?.has(wantedId));
    if (invoices.length === 0) return [];
  }

  const allPersonIds = [
    ...new Set([
      ...[...approvedIdsByInvoice.values()].flatMap((s) => [...s]),
      ...[...waitingIdsByInvoice.values()].flat(),
    ]),
  ];
  const { data: people } =
    allPersonIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", allPersonIds)
      : { data: [] };
  const nameById = new Map((people ?? []).map((p) => [p.id, p.full_name ?? "Team member"]));

  const now = Date.now();
  const rows: InvoiceListRow[] = invoices.map((inv) => {
    const customerIds = projectIdsByInvoice.get(inv.id) ?? new Set<string>();
    const approvedIds = approvedIdsByInvoice.get(inv.id);
    const waitingIds = waitingIdsByInvoice.get(inv.id) ?? [];
    return {
      id: inv.id,
      name: `Bill${inv.invoice_number ? ` ${inv.invoice_number}` : ""} from ${
        inv.vendor_name ?? inv.file_name
      }`,
      amount: inv.amount,
      supplier: inv.vendor_name ?? "—",
      status: inv.status,
      approvedBy: approvedIds && approvedIds.size > 0
        ? [...approvedIds].map((id) => nameById.get(id) ?? "Team member").join(", ")
        : "—",
      waitingFor: waitingIds.length > 0
        ? waitingIds.map((id) => nameById.get(id) ?? "Team member").join(", ")
        : "—",
      createdAt: inv.created_at,
      customers: customerIds.size > 0
        ? [...customerIds].map((id) => projectName.get(id) ?? "Unknown").join(", ")
        : "—",
      ageDays: Math.floor((now - new Date(inv.created_at).getTime()) / DAY_MS),
      queueDays:
        QUEUED_STATUSES.has(inv.status) && inv.current_step_entered_at
          ? Math.floor((now - new Date(inv.current_step_entered_at).getTime()) / DAY_MS)
          : null,
    };
  });

  // Sorted by customer, then supplier — the exact order requested for the
  // download, and what's shown on screen too.
  return rows.sort((a, b) => {
    const c = a.customers.localeCompare(b.customers);
    return c !== 0 ? c : a.supplier.localeCompare(b.supplier);
  });
}

// text/csv, quoting any field that needs it (comma, quote, or newline).
// `columns` picks which optional columns to emit, in REPORT_COLUMNS'
// fixed order — Name always leads regardless. Defaults to
// DEFAULT_REPORT_COLUMNS (the full original set) when omitted, so any
// existing caller that doesn't pass columns keeps its old output exactly.
export function invoiceListToCsv(
  rows: InvoiceListRow[],
  columns: ReportColumnId[] = DEFAULT_REPORT_COLUMNS
): string {
  const escape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

  const active = REPORT_COLUMNS.filter((c) => columns.includes(c.id));
  const cellFor: Record<ReportColumnId, (r: InvoiceListRow) => string> = {
    amount: (r) => (r.amount != null ? r.amount.toFixed(2) : ""),
    supplier: (r) => r.supplier,
    status: (r) => r.status,
    approvedBy: (r) => r.approvedBy,
    waitingFor: (r) => r.waitingFor,
    createdAt: (r) => new Date(r.createdAt).toLocaleString(),
    customers: (r) => r.customers,
    age: (r) => `${r.ageDays}d`,
    queueTime: (r) => (r.queueDays != null ? `${r.queueDays}d` : ""),
  };

  const header = ["Name", ...active.map((c) => c.label)];
  const lines = rows.map((r) =>
    [r.name, ...active.map((c) => cellFor[c.id](r))]
      .map((v) => escape(String(v)))
      .join(",")
  );
  return [header.join(","), ...lines].join("\r\n");
}
