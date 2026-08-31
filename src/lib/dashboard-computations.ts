// Phase 2: every business rule from the original Dashboard page's
// server-side computation, ported UNCHANGED (same logic, same edge
// cases) to run client-side over data fetched once by
// fetchDashboardListData. These are pure functions — no I/O — so moving
// where they execute (browser instead of server) doesn't change what
// they decide, only how fast repeat renders are (no round trip at all).
//
// Keeping this logic verbatim (not "improved") is deliberate: this is
// where duplicate detection, RLS-mirroring for plain users, and
// conditional approval routing live — exactly the kind of subtle
// correctness this app has been debugged into over many sessions.

import type { Database } from "@/lib/supabase/types";
import { normalizeForMatching } from "@/lib/matching";
import {
  effectiveApproversForStep,
  stepDecisionState,
  type StepApprover,
  type StepCondition,
} from "@/lib/workflow-conditions";
import type { DashboardListData } from "@/lib/dashboard-data";
import type { MultiSelectOption } from "@/components/MultiSelect";

export type Invoice = Database["public"]["Tables"]["invoices"]["Row"];
export const VIEWS = ["all", "review", "mine", "ready", "created", "approved", "rejected"] as const;
export type View = (typeof VIEWS)[number];

export interface AdvancedFilters {
  status: string[];
  holder: string[];
  requester: string[];
  approvedBy: string[];
  supplier: string[];
  customer: string[];
  class: string[];
  number: string;
  dateFrom: string;
  dateTo: string;
  amountFrom: string;
  amountTo: string;
}

export const emptyAdvancedFilters = (): AdvancedFilters => ({
  status: [],
  holder: [],
  requester: [],
  approvedBy: [],
  supplier: [],
  customer: [],
  class: [],
  number: "",
  dateFrom: "",
  dateTo: "",
  amountFrom: "",
  amountTo: "",
});

// Precomputed lookup structures shared by every per-invoice rule below —
// built once per list fetch, not recomputed per invoice.
export function buildLookups(data: DashboardListData) {
  const stepApproversByStepId = new Map<string, StepApprover[]>();
  for (const a of data.allStepApprovers) {
    const list = stepApproversByStepId.get(a.step_id) ?? [];
    list.push({ id: a.id, approver_user_id: a.approver_user_id, is_default: a.is_default });
    stepApproversByStepId.set(a.step_id, list);
  }
  const conditionsByStepApproverId = new Map<string, StepCondition[]>();
  for (const c of data.allStepConditions) {
    const list = conditionsByStepApproverId.get(c.step_approver_id) ?? [];
    list.push({
      step_approver_id: c.step_approver_id,
      field: c.field,
      operator: c.operator,
      match_values: c.match_values,
    });
    conditionsByStepApproverId.set(c.step_approver_id, list);
  }
  const stepByKey = new Map(data.allSteps.map((s) => [`${s.workflow_id}:${s.step_order}`, s]));

  const classesByInvoice = new Map<string, Set<string>>();
  const projectsByInvoice = new Map<string, Set<string>>();
  const lineItemsByInvoiceForMatching = new Map<
    string,
    { class: string | null; category: string | null; project_id: string | null }[]
  >();
  for (const inv of data.invoices) {
    if (!inv.project_id) continue;
    const set = projectsByInvoice.get(inv.id) ?? new Set<string>();
    set.add(inv.project_id);
    projectsByInvoice.set(inv.id, set);
  }
  for (const row of data.lineItemRows) {
    const list = lineItemsByInvoiceForMatching.get(row.invoice_id) ?? [];
    list.push({ class: row.class, category: row.category, project_id: row.project_id });
    lineItemsByInvoiceForMatching.set(row.invoice_id, list);
    if (row.class) {
      const set = classesByInvoice.get(row.invoice_id) ?? new Set<string>();
      set.add(row.class);
      classesByInvoice.set(row.invoice_id, set);
    }
    if (row.project_id) {
      const set = projectsByInvoice.get(row.invoice_id) ?? new Set<string>();
      set.add(row.project_id);
      projectsByInvoice.set(row.invoice_id, set);
    }
  }

  const approvedByInvoice = new Map<string, Set<string>>();
  for (const row of data.approvedPairs) {
    if (!row.approver_id) continue;
    const set = approvedByInvoice.get(row.invoice_id) ?? new Set<string>();
    set.add(row.approver_id);
    approvedByInvoice.set(row.invoice_id, set);
  }

  return {
    stepApproversByStepId,
    conditionsByStepApproverId,
    stepByKey,
    classesByInvoice,
    projectsByInvoice,
    lineItemsByInvoiceForMatching,
    approvedByInvoice,
  };
}
export type Lookups = ReturnType<typeof buildLookups>;

export const duplicateGroupKey = (i: Invoice): string | null =>
  i.invoice_number && i.supplier_id
    ? `${i.supplier_id}::${normalizeForMatching(i.invoice_number)}`
    : null;

export function buildDuplicateGroups(invoices: Invoice[]) {
  const duplicateGroups = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    if (inv.status === "cancelled" || inv.status === "rejected") continue;
    const key = duplicateGroupKey(inv);
    if (!key) continue;
    if (!duplicateGroups.has(key)) duplicateGroups.set(key, []);
    duplicateGroups.get(key)!.push(inv);
  }
  const duplicateInvoiceIds = new Set<string>();
  for (const group of duplicateGroups.values()) {
    if (group.length > 1) group.forEach((inv) => duplicateInvoiceIds.add(inv.id));
  }
  return { duplicateGroups, duplicateInvoiceIds };
}

// Who currently has this document, if anyone (ApprovalMax's own "Held
// by" field).
export function holderOf(invoice: Invoice, lookups: Lookups): string[] {
  if (invoice.workflow_id === null || (invoice.status !== "on_approval" && invoice.status !== "on_hold")) {
    return [];
  }
  if (invoice.step_override_approver_id) return [invoice.step_override_approver_id];
  const step = lookups.stepByKey.get(`${invoice.workflow_id}:${invoice.current_step_order}`);
  if (!step) return [];
  const approvers = lookups.stepApproversByStepId.get(step.id) ?? [];
  const conditions = approvers.flatMap((a) => lookups.conditionsByStepApproverId.get(a.id) ?? []);
  return effectiveApproversForStep(
    approvers,
    conditions,
    { vendor_name: invoice.vendor_name, project_id: invoice.project_id },
    lookups.lineItemsByInvoiceForMatching.get(invoice.id) ?? []
  );
}

export function requiresMyApproval(invoice: Invoice, lookups: Lookups, userId: string): boolean {
  return (
    invoice.status === "on_approval" &&
    invoice.workflow_id !== null &&
    holderOf(invoice, lookups).includes(userId)
  );
}

// Every user id who'd end up an effective approver of SOME step on this
// invoice's workflow (any step, not just the current one) — matches the
// DB's is_eligible_approver().
export function eligibleApproverIdsForInvoice(
  invoice: Invoice,
  allSteps: DashboardListData["allSteps"],
  lookups: Lookups
): string[] {
  if (invoice.workflow_id === null) return [];
  const ids = new Set<string>();
  for (const step of allSteps) {
    if (step.workflow_id !== invoice.workflow_id) continue;
    const approvers = lookups.stepApproversByStepId.get(step.id) ?? [];
    const conditions = approvers.flatMap((a) => lookups.conditionsByStepApproverId.get(a.id) ?? []);
    const effective = effectiveApproversForStep(
      approvers,
      conditions,
      { vendor_name: invoice.vendor_name, project_id: invoice.project_id },
      lookups.lineItemsByInvoiceForMatching.get(invoice.id) ?? []
    );
    for (const id of effective) ids.add(id);
  }
  return [...ids];
}

// A plain "user" only sees invoices for projects they're eligible-
// approver-on plus whatever they submitted themselves — mirrors
// migration 0067's RLS policy (see the original page's long comment on
// why this mirror exists: getCachedInvoiceList bypasses per-user RLS for
// org-wide caching).
export function visibleInvoicesFor(data: DashboardListData, lookups: Lookups): Invoice[] {
  if (data.org.role !== "user") return data.invoices;
  return data.invoices.filter(
    (i) =>
      i.status !== "on_review" &&
      (i.submitted_by === data.user.id ||
        eligibleApproverIdsForInvoice(i, data.allSteps, lookups).includes(data.user.id))
  );
}

export function applyViewAndFilters(
  visibleInvoices: Invoice[],
  view: View,
  q: string,
  advanced: AdvancedFilters,
  lookups: Lookups,
  userId: string
): Invoice[] {
  let filtered = visibleInvoices;
  if (view === "review") filtered = filtered.filter((i) => i.status === "on_review");
  else if (view === "mine") filtered = filtered.filter((i) => requiresMyApproval(i, lookups, userId));
  else if (view === "ready") filtered = filtered.filter((i) => i.status === "qbo_ready");
  else if (view === "created") filtered = filtered.filter((i) => i.submitted_by === userId);
  else if (view === "approved") filtered = filtered.filter((i) => i.status === "approved");
  else if (view === "rejected") filtered = filtered.filter((i) => i.status === "rejected");

  if (q) {
    const needle = q.toLowerCase();
    filtered = filtered.filter((i) =>
      [i.vendor_name, i.file_name, i.invoice_number].some((f) => f?.toLowerCase().includes(needle))
    );
  }

  if (advanced.status.length > 0) filtered = filtered.filter((i) => advanced.status.includes(i.status));
  if (advanced.holder.length > 0) {
    filtered = filtered.filter((i) => holderOf(i, lookups).some((id) => advanced.holder.includes(id)));
  }
  if (advanced.requester.length > 0) {
    filtered = filtered.filter((i) => i.submitted_by !== null && advanced.requester.includes(i.submitted_by));
  }
  if (advanced.approvedBy.length > 0) {
    filtered = filtered.filter((i) => {
      const approvers = lookups.approvedByInvoice.get(i.id);
      return approvers != null && advanced.approvedBy.some((a) => approvers.has(a));
    });
  }
  if (advanced.supplier.length > 0) {
    filtered = filtered.filter((i) => i.supplier_id !== null && advanced.supplier.includes(i.supplier_id));
  }
  if (advanced.customer.length > 0) {
    filtered = filtered.filter((i) => {
      const invoiceProjects = lookups.projectsByInvoice.get(i.id);
      return invoiceProjects != null && advanced.customer.some((c) => invoiceProjects.has(c));
    });
  }
  if (advanced.class.length > 0) {
    filtered = filtered.filter((i) => {
      const invoiceClasses = lookups.classesByInvoice.get(i.id);
      return invoiceClasses != null && advanced.class.some((c) => invoiceClasses.has(c));
    });
  }
  if (advanced.number.trim()) {
    const needle = advanced.number.trim().toLowerCase();
    filtered = filtered.filter((i) => i.invoice_number?.toLowerCase().includes(needle));
  }
  if (advanced.dateFrom) filtered = filtered.filter((i) => i.bill_date !== null && i.bill_date >= advanced.dateFrom);
  if (advanced.dateTo) filtered = filtered.filter((i) => i.bill_date !== null && i.bill_date <= advanced.dateTo);
  if (advanced.amountFrom) {
    const min = Number(advanced.amountFrom);
    filtered = filtered.filter((i) => i.amount !== null && i.amount >= min);
  }
  if (advanced.amountTo) {
    const max = Number(advanced.amountTo);
    filtered = filtered.filter((i) => i.amount !== null && i.amount <= max);
  }
  return filtered;
}

// Pins duplicate pairs/groups together at the top for list display only
// — `filtered` (created_at DESC) stays the source of truth for default
// selection; this only reshapes render order.
export function pinDuplicatesForDisplay(
  filtered: Invoice[],
  duplicateInvoiceIds: Set<string>
): Invoice[] {
  const pinnedGroupsMap = new Map<string, Invoice[]>();
  const unpinnedInDisplayOrder: Invoice[] = [];
  for (const inv of filtered) {
    if (!duplicateInvoiceIds.has(inv.id)) {
      unpinnedInDisplayOrder.push(inv);
      continue;
    }
    const key = duplicateGroupKey(inv)!;
    if (!pinnedGroupsMap.has(key)) pinnedGroupsMap.set(key, []);
    pinnedGroupsMap.get(key)!.push(inv);
  }
  return [...[...pinnedGroupsMap.values()].flat(), ...unpinnedInDisplayOrder];
}

export function computeCounts(visibleInvoices: Invoice[], lookups: Lookups, userId: string) {
  return {
    all: visibleInvoices.length,
    review: visibleInvoices.filter((i) => i.status === "on_review").length,
    mine: visibleInvoices.filter((i) => requiresMyApproval(i, lookups, userId)).length,
    ready: visibleInvoices.filter((i) => i.status === "qbo_ready").length,
    created: visibleInvoices.filter((i) => i.submitted_by === userId).length,
    approved: visibleInvoices.filter((i) => i.status === "approved").length,
    rejected: visibleInvoices.filter((i) => i.status === "rejected").length,
  };
}

export function vendorOptionsFor(invoices: Invoice[]): MultiSelectOption[] {
  const vendorLabelBySupplierId = new Map<string, string>();
  for (const i of invoices) {
    if (!i.supplier_id || !i.vendor_name) continue;
    if (!vendorLabelBySupplierId.has(i.supplier_id)) vendorLabelBySupplierId.set(i.supplier_id, i.vendor_name);
  }
  return [...vendorLabelBySupplierId.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, label]) => ({ id, label }));
}

export function classOptionsFor(lineItemRows: DashboardListData["lineItemRows"]): MultiSelectOption[] {
  return [...new Set(lineItemRows.map((r) => r.class).filter((c): c is string => !!c))]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ id: c, label: c }));
}

export { stepDecisionState };
