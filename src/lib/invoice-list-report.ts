import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { filterInvoicesForReport, type ReportFilters } from "@/lib/reports";
import { requiredApproversFor } from "@/lib/dashboard-actions";

// Per-invoice list, the ApprovalMax-style "Request reports" download —
// unlike runReport (grouped counts/sums), this is one row per invoice,
// sorted by customer then supplier, meant to be read as a list or
// exported as-is. Authored by Araza.

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
}

export async function buildInvoiceListReport(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  filters: ReportFilters
): Promise<InvoiceListRow[]> {
  const { data: invoicesRaw } = await supabase
    .from("invoices")
    .select(
      "id, vendor_name, invoice_number, file_name, amount, status, created_at, project_id, workflow_id, current_step_order, step_override_approver_id"
    )
    .eq("organization_id", organizationId);
  const invoices = filterInvoicesForReport(invoicesRaw ?? [], filters);
  if (invoices.length === 0) return [];

  const invoiceIds = invoices.map((i) => i.id);

  const [{ data: lineItems }, { data: approvals }, { data: projects }] =
    await Promise.all([
      supabase
        .from("invoice_line_items")
        .select("invoice_id, class, category, project_id")
        .in("invoice_id", invoiceIds),
      supabase
        .from("invoice_approvals")
        .select("invoice_id, approver_id, decision")
        .in("invoice_id", invoiceIds)
        .eq("decision", "approved"),
      supabase.from("projects").select("id, name").eq("organization_id", organizationId),
    ]);

  const projectName = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const lineItemsByInvoice = new Map<
    string,
    { class: string | null; category: string | null; project_id: string | null }[]
  >();
  for (const li of lineItems ?? []) {
    const list = lineItemsByInvoice.get(li.invoice_id) ?? [];
    list.push({ class: li.class, category: li.category, project_id: li.project_id });
    lineItemsByInvoice.set(li.invoice_id, list);
  }
  const approvedIdsByInvoice = new Map<string, Set<string>>();
  for (const a of approvals ?? []) {
    if (!a.approver_id) continue;
    const set = approvedIdsByInvoice.get(a.invoice_id) ?? new Set<string>();
    set.add(a.approver_id);
    approvedIdsByInvoice.set(a.invoice_id, set);
  }

  // "Waiting for" needs the current step's effective approvers per
  // invoice — reuses requiredApproversFor (dashboard-actions.ts) so this
  // matches EXACTLY who'd see Approve/Reject on the invoice itself,
  // rather than re-deriving the same matching logic a second way.
  const waitingIdsByInvoice = new Map<string, string[]>();
  const workflowIds = [
    ...new Set(invoices.map((i) => i.workflow_id).filter((id): id is string => !!id)),
  ];
  const { data: stepsRaw } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_steps")
          .select("*")
          .in("workflow_id", workflowIds)
      : { data: [] };
  const stepByKey = new Map(
    (stepsRaw ?? []).map((s) => [`${s.workflow_id}:${s.step_order}`, s])
  );
  for (const inv of invoices) {
    if (
      (inv.status !== "on_approval" && inv.status !== "on_hold") ||
      !inv.workflow_id
    ) {
      continue;
    }
    const step = stepByKey.get(`${inv.workflow_id}:${inv.current_step_order}`);
    if (!step) continue;
    const ids = await requiredApproversFor(supabase, step, {
      id: inv.id,
      vendor_name: inv.vendor_name,
      project_id: inv.project_id,
      step_override_approver_id: inv.step_override_approver_id,
    });
    waitingIdsByInvoice.set(inv.id, ids);
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

  const rows: InvoiceListRow[] = invoices.map((inv) => {
    const customerIds = new Set<string>();
    if (inv.project_id) customerIds.add(inv.project_id);
    for (const li of lineItemsByInvoice.get(inv.id) ?? []) {
      if (li.project_id) customerIds.add(li.project_id);
    }
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
export function invoiceListToCsv(rows: InvoiceListRow[]): string {
  const escape = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const header = [
    "Name",
    "Amount",
    "Supplier",
    "Status",
    "Approved by",
    "Waiting for",
    "Creation date",
    "Customers",
  ];
  const lines = rows.map((r) =>
    [
      r.name,
      r.amount != null ? r.amount.toFixed(2) : "",
      r.supplier,
      r.status,
      r.approvedBy,
      r.waitingFor,
      new Date(r.createdAt).toLocaleString(),
      r.customers,
    ]
      .map((v) => escape(String(v)))
      .join(",")
  );
  return [header.join(","), ...lines].join("\r\n");
}
