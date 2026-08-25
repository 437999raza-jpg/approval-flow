// Vercel Hobby caps configurable duration at 60s — the
// OpenRouter extraction call can take 20-60s.
export const maxDuration = 60;

import Link from "next/link";
import { clsx } from "clsx";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import {
  getCachedQboCategories,
  getCachedQboSuppliers,
  getCachedQboClasses,
  getCachedQboTaxRates,
  getCachedQboTaxCodes,
  getCachedMemberRoster,
  getCachedInvoiceList,
} from "@/lib/org-cache";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { SearchInput } from "@/components/SearchInput";
import { SignOutButton } from "@/components/SignOutButton";
import { CollapsiblePane } from "@/components/CollapsiblePane";
import { DetailSplit, type DocumentRef } from "@/components/DetailSplit";
import { Sidebar } from "@/components/Sidebar";
import { DocumentFocusProvider } from "@/components/DocumentFocusContext";
import { ExtractionPoller } from "@/components/ExtractionPoller";
import { LocalTime } from "@/components/LocalTime";
import { DocumentSearchModal, type DocumentSearchFilters } from "@/components/DocumentSearchModal";
import type { SupplierDefaultsValues } from "@/components/SupplierRulesModal";
import type { MultiSelectOption } from "@/components/MultiSelect";
import type { Database, InvoiceStatus } from "@/lib/supabase/types";
import { isPdfName, isImageName } from "@/lib/file-types";
import { normalizeForMatching } from "@/lib/matching";
import { buildAuditTimeline } from "@/lib/audit-timeline";
import {
  effectiveApproversForStep,
  stepDecisionState,
  type StepApprover,
  type StepCondition,
} from "@/lib/workflow-conditions";
import {
  backToReview,
  cancelInvoice,
  decide,
  addComment,
  addDocument,
  saveAccountingInstructions,
  recomputeInvoiceTotals,
  saveBill,
  saveSupplierDefaults,
  reviewComplete,
  holdInvoice,
  unholdInvoice,
  deleteInvoiceAction,
  reassignApprover,
  overrideStatus,
  saveLineItem,
  deleteLineItem,
  cloneLineItem,
  reExtract,
  getInvoicePageCount,
  reorderInvoicePages,
  syncToQbo,
  clearQboError,
  clearQboSync,
} from "@/lib/dashboard-actions";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];

const VIEWS = ["all", "review", "mine", "ready", "created", "approved", "rejected"] as const;
type View = (typeof VIEWS)[number];

const STATUS_OPTIONS: MultiSelectOption[] = [
  { id: "on_review", label: "On review" },
  { id: "on_approval", label: "On approval" },
  { id: "qbo_ready", label: "QBO Ready" },
  { id: "approved", label: "Approved" },
  { id: "cancelled", label: "Cancelled" },
  { id: "rejected", label: "Rejected" },
  { id: "on_hold", label: "On hold" },
];

function csvParam(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

const DECISION_ERRORS: Record<string, string> = {
  "not-your-step":
    "Only the approver assigned to the current step can approve or reject this invoice.",
  "already-decided": "This invoice has already been decided at this step.",
  "step-required":
    "Earlier approval steps must be completed before this step can be decided.",
  "cos-requires-note":
    "This invoice has COs or Extras — a note for accounting is required before you can approve.",
};

// Record a single approve/reject decision for the current workflow step.
// Enforces, in order: signed-in user, invoice visible to the caller's org
// (via RLS on the read), invoice still open, caller is the approver assigned
// to the current step, all prior steps approved, and no decision already
// recorded for this step. The (invoice_id, step_order) unique constraint
// added in migration 0002 makes double-decisions impossible even under a
// race.
//
// Who's actually required to decide the given step for this invoice — a
// step can have several conditionally-matched approvers now (see
// workflow-conditions.ts). An admin reassignment overrides everything to
// just that one person. Shared by every server action that needs to
// check "is this user allowed to act on this step right now".
export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: { id?: string[] };
  searchParams: {
    view?: string;
    q?: string;
    error?: string;
    status?: string;
    holder?: string;
    requester?: string;
    approvedBy?: string;
    supplier?: string;
    customer?: string;
    class?: string;
    number?: string;
    dateFrom?: string;
    dateTo?: string;
    amountFrom?: string;
    amountTo?: string;
  };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-xl font-semibold">No organization yet</h1>
        <p className="mt-2 text-slate-600">
          Your account isn&apos;t attached to an organization. Insert a row into
          <code className="mx-1 rounded bg-slate-100 px-1">organizations</code>
          and <code className="mx-1 rounded bg-slate-100 px-1">organization_members</code>
          to get started (see the README).
        </p>
        <div className="mt-4 flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="truncate text-slate-600">
            Signed in as <strong>{user.email}</strong>{" "}
            <span className="text-xs text-slate-400">
              (user id {user.id.slice(0, 8)}…)
            </span>
          </span>
          <span className="flex-1" />
          <SignOutButton />
        </div>
      </main>
    );
  }

  const selectedId = params.id?.[0];
  const isAuditor = org.role === "auditor";
  // Review (the Pending Review queue) is admin-only; auditors can view it
  // read-only; users never see pending_review invoices (RLS enforces this
  // at the data level too).
  const canReviewNow = org.role === "admin";
  const canSeeReviewQueue = org.role === "admin" || isAuditor;
  const canEdit = !isAuditor;
  const view: View = VIEWS.includes(searchParams.view as View)
    ? (searchParams.view as View)
    : "all";
  const q = searchParams.q?.trim().toLowerCase() ?? "";

  const [
    { data: workflows },
    { data: projects },
    qboCategoryRows,
    qboSupplierRows,
    qboClassRows,
    qboTaxRateRows,
    qboTaxCodeRows,
    pendingSplitsRes,
    unreadNotificationsRes,
  ] = await Promise.all([
    supabase
      .from("approval_workflows")
      .select("id")
      .eq("organization_id", org.id),
    supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", org.id)
      .eq("active", true)
      .order("name", { ascending: true }),
    // QBO mirrors are cached per-org (org-cache.ts) — they only change when
    // an admin syncs, so don't refetch 2,000+ rows on every navigation.
    getCachedQboCategories(org.id),
    getCachedQboSuppliers(org.id),
    getCachedQboClasses(org.id),
    getCachedQboTaxRates(org.id),
    getCachedQboTaxCodes(org.id),
    supabase
      .from("pending_invoice_splits")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .eq("status", "pending"),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("read", false),
  ]);

  // The invoice list (+ the approved-pairs and line-item lookups derived
  // from it) is cached per-org and invalidated by every invoice-mutating
  // action — so clicking between invoices doesn't re-download everything.
  const {
    invoices,
    approvedPairs: approvedRows,
    lineItemRows,
  } = await getCachedInvoiceList(org.id);
  const pendingSplitsCount = pendingSplitsRes.count ?? 0;
  const unreadNotificationsCount = unreadNotificationsRes.count ?? 0;

  const workflowIds = (workflows ?? []).map((w) => w.id);
  const invoiceIds = (invoices ?? []).map((i) => i.id);

  // Duplicate detection, org-wide: same (normalized vendor name, invoice
  // number), excluding cancelled/rejected invoices from the pool. Reused
  // for both the per-invoice "Possible duplicate" banner below and for
  // pinning/badging duplicate pairs in the list pane. Vendor/invoice
  // numbers are normalized (lowercase, punctuation collapsed — e.g.
  // "ONYX•FIRE…" and "ONYX FIRE…" match), see src/lib/matching.ts.
  const duplicateGroupKey = (i: Invoice): string | null =>
    i.invoice_number && i.vendor_name
      ? `${normalizeForMatching(i.vendor_name)}::${normalizeForMatching(i.invoice_number)}`
      : null;
  const duplicateGroups = new Map<string, Invoice[]>();
  for (const inv of invoices ?? []) {
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

  const { data: allSteps } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_steps")
          .select("*")
          .in("workflow_id", workflowIds)
          .order("step_order", { ascending: true })
      : { data: [] };
  const stepIds = (allSteps ?? []).map((s) => s.id);

  // QBO connection (RLS: admins only — everyone else gets null).
  const { data: qboConnection } = await supabase
    .from("qbo_connections")
    .select("realm_id, company_name")
    .eq("organization_id", org.id)
    .maybeSingle();

  const [
    { data: allStepApprovers },
  ] = await Promise.all([
    stepIds.length > 0
      ? supabase
          .from("approval_workflow_step_approvers")
          .select("*")
          .in("step_id", stepIds)
          .order("row_order", { ascending: true })
      : Promise.resolve({ data: [] }),
  ]);

  const { memberUserIds, profileRows } = await getCachedMemberRoster(org.id);

  const stepApproverIds = (allStepApprovers ?? []).map((a) => a.id);
  const { data: allStepConditions } =
    stepApproverIds.length > 0
      ? await supabase
          .from("approval_workflow_step_conditions")
          .select("*")
          .in("step_approver_id", stepApproverIds)
      : { data: [] };

  const memberNameById = new Map(
    (profileRows ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
  );
  const memberOptions: MultiSelectOption[] = memberUserIds
    .map((id) => ({ id, label: memberNameById.get(id) ?? "Team member" }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const vendorOptions: MultiSelectOption[] = [
    ...new Set((invoices ?? []).map((i) => i.vendor_name).filter((v): v is string => !!v)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ id: v, label: v }));

  const projectOptions: MultiSelectOption[] = (projects ?? []).map((p) => ({
    id: p.id,
    label: p.name,
  }));

  // QBO mirrors for the Bill panel dropdowns (read-only — never written to QBO).
  // Categories show as "5-15450 - HVAC" (account number + name), so typing
  // "hvac" surfaces the full numbered category, like QBO.
  const qboCategoryNames: string[] = [
    ...new Set(
      (qboCategoryRows ?? []).map((c) =>
        c.acct_num ? `${c.acct_num} - ${c.name}` : c.name
      )
    ),
  ].sort((a, b) => a.localeCompare(b));
  const qboSupplierNames: string[] = [
    ...new Set((qboSupplierRows ?? []).map((s) => s.name)),
  ].sort((a, b) => a.localeCompare(b));  const qboClassNames: string[] = [
    ...new Set((qboClassRows ?? []).map((c) => c.name)),
  ].sort((a, b) => a.localeCompare(b));
  const qboTaxRateOptions: { value: string; label: string }[] = (
    qboTaxRateRows ?? []
  ).map((r) => ({
    value: String(r.rate_value),
    label: `${r.rate_value}% — ${r.name}`,
  }));

  // Tax field offers the QBO codes with their resolved rates, exactly like
  // Dext/ApprovalMax: type "h" → "H (13%)" → picks it, box shows "13". The
  // submitted value is the QBO tax code id (not the rate) — two codes can
  // resolve to the same rate (e.g. "H" and "M&E (ON)" both 13%), so the
  // rate alone can't tell QBO which one to use; the rate itself still
  // rides along as secondaryValue for the app's own tax-total math.
  const qboTaxCodeOptions: { value: string; label: string; secondaryValue: string }[] = (
    qboTaxCodeRows ?? []
  )
    .filter((c) => c.rate_value != null)
    .map((c) => ({
      value: c.qbo_tax_code_id,
      label: `${c.name} (${c.rate_value}%)`,
      secondaryValue: String(c.rate_value),
    }));

  // Supplier default rules only ever store a plain rate (no per-org tax
  // code identity to disambiguate against — see supplier_defaults.tax_rate
  // and its "apply to inbox" bulk-update path), so its Tax field keeps the
  // old rate-as-value shape rather than the line-item Tax field's code id.
  const qboTaxCodeRateOnlyOptions: { value: string; label: string }[] = (
    qboTaxCodeRows ?? []
  )
    .filter((c) => c.rate_value != null)
    .map((c) => ({
      value: String(c.rate_value),
      label: `${c.name} (${c.rate_value}%)`,
    }));
  const qboSupplierDefaultTaxOptions =
    qboTaxCodeRateOnlyOptions.length > 0 ? qboTaxCodeRateOnlyOptions : qboTaxRateOptions;

  const classOptions: MultiSelectOption[] = [
    ...new Set((lineItemRows ?? []).map((r) => r.class).filter((c): c is string => !!c)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ id: c, label: c }));

  // Class lives on line items, not the invoice itself — an invoice matches
  // a Class filter if ANY of its line items carry that class.
  const classesByInvoice = new Map<string, Set<string>>();
  const lineItemsByInvoiceForMatching = new Map<
    string,
    { class: string | null; category: string | null; project_id: string | null }[]
  >();
  for (const row of lineItemRows ?? []) {
    const list = lineItemsByInvoiceForMatching.get(row.invoice_id) ?? [];
    list.push({ class: row.class, category: row.category, project_id: row.project_id });
    lineItemsByInvoiceForMatching.set(row.invoice_id, list);
    if (!row.class) continue;
    const set = classesByInvoice.get(row.invoice_id) ?? new Set<string>();
    set.add(row.class);
    classesByInvoice.set(row.invoice_id, set);
  }

  const approvedByInvoice = new Map<string, Set<string>>();
  for (const row of approvedRows ?? []) {
    if (!row.approver_id) continue;
    const set = approvedByInvoice.get(row.invoice_id) ?? new Set<string>();
    set.add(row.approver_id);
    approvedByInvoice.set(row.invoice_id, set);
  }

  // Per-step conditional routing: which approvers are actually "in play"
  // for a given step depends on the specific invoice (its supplier/class/
  // customer) — see workflow-conditions.ts for the matching rules this
  // mirrors from is_eligible_approver() (migration 0027).
  const stepApproversByStepId = new Map<string, StepApprover[]>();
  for (const a of allStepApprovers ?? []) {
    const list = stepApproversByStepId.get(a.step_id) ?? [];
    list.push({ id: a.id, approver_user_id: a.approver_user_id, is_default: a.is_default });
    stepApproversByStepId.set(a.step_id, list);
  }
  const conditionsByStepApproverId = new Map<string, StepCondition[]>();
  for (const c of allStepConditions ?? []) {
    const list = conditionsByStepApproverId.get(c.step_approver_id) ?? [];
    list.push({
      step_approver_id: c.step_approver_id,
      field: c.field,
      operator: c.operator,
      match_values: c.match_values,
    });
    conditionsByStepApproverId.set(c.step_approver_id, list);
  }
  const stepByKey = new Map(
    (allSteps ?? []).map((s) => [`${s.workflow_id}:${s.step_order}`, s])
  );

  // Who currently has this document, if anyone — the field ApprovalMax's
  // own search screen doesn't offer (only "Requester" and "Approved by").
  // A step can have several conditionally-matched approvers now, so this
  // returns all of them (usually one, sometimes more when "all" mode
  // requires everyone to sign off, or the invoice's data happens to match
  // more than one approver's condition). An admin's reassignment
  // (step_override_approver_id) wins over the workflow's own routing,
  // but only for this one invoice — the workflow template is untouched.
  const holderOf = (invoice: Invoice): string[] => {
    if (
      invoice.workflow_id === null ||
      (invoice.status !== "on_approval" && invoice.status !== "on_hold")
    ) {
      return [];
    }
    if (invoice.step_override_approver_id) {
      return [invoice.step_override_approver_id];
    }
    const step = stepByKey.get(`${invoice.workflow_id}:${invoice.current_step_order}`);
    if (!step) return [];
    const approvers = stepApproversByStepId.get(step.id) ?? [];
    const conditions = approvers.flatMap(
      (a) => conditionsByStepApproverId.get(a.id) ?? []
    );
    return effectiveApproversForStep(
      approvers,
      conditions,
      { vendor_name: invoice.vendor_name, project_id: invoice.project_id },
      lineItemsByInvoiceForMatching.get(invoice.id) ?? []
    );
  };

  const requiresMyApproval = (invoice: Invoice) =>
    invoice.status === "on_approval" &&
    invoice.workflow_id !== null &&
    holderOf(invoice).includes(user.id);

  const counts = {
    all: invoices?.length ?? 0,
    review: invoices?.filter((i) => i.status === "on_review").length ?? 0,
    mine: invoices?.filter(requiresMyApproval).length ?? 0,
    ready: invoices?.filter((i) => i.status === "qbo_ready").length ?? 0,
    created: invoices?.filter((i) => i.submitted_by === user.id).length ?? 0,
    approved: invoices?.filter((i) => i.status === "approved").length ?? 0,
    rejected: invoices?.filter((i) => i.status === "rejected").length ?? 0,
  };

  let filtered = invoices ?? [];
  if (view === "review") filtered = filtered.filter((i) => i.status === "on_review");
  else if (view === "mine") filtered = filtered.filter(requiresMyApproval);
  else if (view === "ready") filtered = filtered.filter((i) => i.status === "qbo_ready");
  else if (view === "created") filtered = filtered.filter((i) => i.submitted_by === user.id);
  else if (view === "approved") filtered = filtered.filter((i) => i.status === "approved");
  else if (view === "rejected") filtered = filtered.filter((i) => i.status === "rejected");

  if (q) {
    filtered = filtered.filter((i) =>
      [i.vendor_name, i.file_name, i.invoice_number].some((f) =>
        f?.toLowerCase().includes(q)
      )
    );
  }

  // Advanced "Document search" filters — each multi-select field matches
  // ANY of its selected values (vendor A OR vendor B); different fields
  // combine with AND, layered on top of the sidebar view + quick search.
  const advanced: DocumentSearchFilters = {
    status: csvParam(searchParams.status),
    holder: csvParam(searchParams.holder),
    requester: csvParam(searchParams.requester),
    approvedBy: csvParam(searchParams.approvedBy),
    supplier: csvParam(searchParams.supplier),
    customer: csvParam(searchParams.customer),
    class: csvParam(searchParams.class),
    number: searchParams.number ?? "",
    dateFrom: searchParams.dateFrom ?? "",
    dateTo: searchParams.dateTo ?? "",
    amountFrom: searchParams.amountFrom ?? "",
    amountTo: searchParams.amountTo ?? "",
  };
  const activeFilterCount =
    [
      advanced.status,
      advanced.holder,
      advanced.requester,
      advanced.approvedBy,
      advanced.supplier,
      advanced.customer,
      advanced.class,
    ].filter((a) => a.length > 0).length +
    [advanced.number, advanced.dateFrom, advanced.dateTo, advanced.amountFrom, advanced.amountTo]
      .filter(Boolean).length;

  if (advanced.status.length > 0) {
    filtered = filtered.filter((i) => advanced.status.includes(i.status));
  }
  if (advanced.holder.length > 0) {
    filtered = filtered.filter((i) =>
      holderOf(i).some((id) => advanced.holder.includes(id))
    );
  }
  if (advanced.requester.length > 0) {
    filtered = filtered.filter(
      (i) => i.submitted_by !== null && advanced.requester.includes(i.submitted_by)
    );
  }
  if (advanced.approvedBy.length > 0) {
    filtered = filtered.filter((i) => {
      const approvers = approvedByInvoice.get(i.id);
      return approvers != null && advanced.approvedBy.some((a) => approvers.has(a));
    });
  }
  if (advanced.supplier.length > 0) {
    filtered = filtered.filter(
      (i) => i.vendor_name !== null && advanced.supplier.includes(i.vendor_name)
    );
  }
  if (advanced.customer.length > 0) {
    filtered = filtered.filter(
      (i) => i.project_id !== null && advanced.customer.includes(i.project_id)
    );
  }
  if (advanced.class.length > 0) {
    filtered = filtered.filter((i) => {
      const invoiceClasses = classesByInvoice.get(i.id);
      return invoiceClasses != null && advanced.class.some((c) => invoiceClasses.has(c));
    });
  }
  if (advanced.number.trim()) {
    const needle = advanced.number.trim().toLowerCase();
    filtered = filtered.filter((i) => i.invoice_number?.toLowerCase().includes(needle));
  }
  if (advanced.dateFrom) {
    filtered = filtered.filter((i) => i.bill_date !== null && i.bill_date >= advanced.dateFrom);
  }
  if (advanced.dateTo) {
    filtered = filtered.filter((i) => i.bill_date !== null && i.bill_date <= advanced.dateTo);
  }
  if (advanced.amountFrom) {
    const min = Number(advanced.amountFrom);
    filtered = filtered.filter((i) => i.amount !== null && i.amount >= min);
  }
  if (advanced.amountTo) {
    const max = Number(advanced.amountTo);
    filtered = filtered.filter((i) => i.amount !== null && i.amount <= max);
  }

  const selected = selectedId ? filtered.find((i) => i.id === selectedId) : filtered[0];
  if (selectedId && !selected) notFound();

  // List display only: pin duplicate pairs/groups together at the very
  // top, newest group first — grouped by their duplicate key (not just
  // individually bubbled up), so a resubmission surfaces right next to
  // the invoice it duplicates instead of getting lost further down.
  // `filtered` (created_at DESC) stays the source of truth for default
  // selection and every other computation — this only reshapes the list
  // pane's render order.
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
  // `filtered` is already created_at DESC, so within each group (and
  // across groups, by each group's first/newest member) that order is
  // preserved — no extra sort needed.
  const pinnedDuplicates = [...pinnedGroupsMap.values()].flat();
  const filteredForDisplay = [...pinnedDuplicates, ...unpinnedInDisplayOrder];

  // Possible duplicate: same supplier + invoice number already exists and
  // isn't cancelled/rejected. Computed live (not stored) so it never goes
  // stale if invoice_number/vendor_name get edited later in the Bill panel.
  // Amount differing is flagged as a likely price-corrected resubmission,
  // not treated as a stronger/weaker signal — a human still decides either
  // way.
  const possibleDuplicates: Invoice[] =
    selected?.invoice_number && selected?.vendor_name
      ? (invoices ?? []).filter(
          (i) =>
            i.id !== selected.id &&
            i.status !== "cancelled" &&
            i.status !== "rejected" &&
            i.invoice_number === selected.invoice_number &&
            i.vendor_name?.trim().toLowerCase() ===
              selected.vendor_name!.trim().toLowerCase()
        )
      : [];

  const detailQuery = new URLSearchParams();
  if (view !== "all") detailQuery.set("view", view);
  if (q) detailQuery.set("q", q);
  if (advanced.status.length) detailQuery.set("status", advanced.status.join(","));
  if (advanced.holder.length) detailQuery.set("holder", advanced.holder.join(","));
  if (advanced.requester.length) detailQuery.set("requester", advanced.requester.join(","));
  if (advanced.approvedBy.length) detailQuery.set("approvedBy", advanced.approvedBy.join(","));
  if (advanced.supplier.length) detailQuery.set("supplier", advanced.supplier.join(","));
  if (advanced.customer.length) detailQuery.set("customer", advanced.customer.join(","));
  if (advanced.class.length) detailQuery.set("class", advanced.class.join(","));
  if (advanced.number) detailQuery.set("number", advanced.number);
  if (advanced.dateFrom) detailQuery.set("dateFrom", advanced.dateFrom);
  if (advanced.dateTo) detailQuery.set("dateTo", advanced.dateTo);
  if (advanced.amountFrom) detailQuery.set("amountFrom", advanced.amountFrom);
  if (advanced.amountTo) detailQuery.set("amountTo", advanced.amountTo);
  const qs = detailQuery.toString() ? `?${detailQuery.toString()}` : "";

  let signedFileUrl: string | null = null;
  let stepsForSelected: NonNullable<typeof allSteps> = [];
  let approvalsForSelected: Database["public"]["Tables"]["invoice_approvals"]["Row"][] = [];
  let commentsForSelected: Database["public"]["Tables"]["invoice_comments"]["Row"][] = [];
  let documentsForSelected: DocumentRef[] = [];
  let lineItemsForSelected: Database["public"]["Tables"]["invoice_line_items"]["Row"][] = [];
  let auditEntriesForSelected: Database["public"]["Tables"]["audit_log"]["Row"][] = [];
  let authorNameById = new Map<string, string>();
  let instructionEntriesForSelected: {
    id: string;
    authorName: string;
    body: string;
    createdAt: string;
  }[] = [];
  let supplierDefaultsForSelected: SupplierDefaultsValues = {
    category: "",
    class: "",
    product_service: "",
    project_id: "",
    tax_rate: "",
    payment_terms_days: "",
    currency: "",
  };

  if (selected) {
    const [signed, approvalsRes, commentsRes, docsRes, lineItemsRes, auditRes] =
      await Promise.all([
        supabase.storage.from("invoices").createSignedUrl(selected.file_path, 60 * 10),
        supabase.from("invoice_approvals").select("*").eq("invoice_id", selected.id),
        supabase
          .from("invoice_comments")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("invoice_documents")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("invoice_line_items")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("line_order", { ascending: true }),
        supabase
          .from("audit_log")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("created_at", { ascending: true }),
      ]);
    signedFileUrl = signed.data?.signedUrl ?? null;
    approvalsForSelected = approvalsRes.data ?? [];
    commentsForSelected = commentsRes.data ?? [];
    lineItemsForSelected = lineItemsRes.data ?? [];
    auditEntriesForSelected = auditRes.data ?? [];
    stepsForSelected = (allSteps ?? []).filter((s) => s.workflow_id === selected.workflow_id);

    if (selected.vendor_name) {
      const { data: sd } = await supabase
        .from("supplier_defaults")
        .select("*")
        .eq("organization_id", org.id)
        .eq("vendor_name_normalized", normalizeForMatching(selected.vendor_name))
        .maybeSingle();
      if (sd) {
        supplierDefaultsForSelected = {
          category: sd.category ?? "",
          class: sd.class ?? "",
          product_service: sd.product_service ?? "",
          project_id: sd.project_id ?? "",
          tax_rate: sd.tax_rate?.toString() ?? "",
          payment_terms_days: sd.payment_terms_days?.toString() ?? "",
          currency: sd.currency ?? "",
        };
      } else {
        // No saved rule yet — prefill from what's already on this invoice
        // (its first line item + currency/dates) instead of a blank form,
        // so confirming a new rule is a one-click "yes, remember this"
        // rather than retyping everything a second time.
        const firstLine = lineItemsForSelected[0];
        const termsDays =
          selected.bill_date && selected.due_date
            ? Math.round(
                (new Date(`${selected.due_date}T00:00:00Z`).getTime() -
                  new Date(`${selected.bill_date}T00:00:00Z`).getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            : null;
        supplierDefaultsForSelected = {
          category: firstLine?.category ?? "",
          class: firstLine?.class ?? "",
          product_service: "",
          project_id: firstLine?.project_id ?? "",
          tax_rate: firstLine?.tax_rate?.toString() ?? "",
          payment_terms_days: termsDays != null && termsDays >= 0 ? termsDays.toString() : "",
          currency: selected.currency ?? "",
        };
      }
    }

    // Document list for the viewer: the primary file first, then any
    // additional pages (multi-document support, migration 0003).
    const attachmentRows = docsRes.data ?? [];
    const attachmentUrls = await Promise.all(
      attachmentRows.map(async (d) => {
        const { data } = await supabase.storage
          .from("invoices")
          .createSignedUrl(d.file_path, 60 * 10);
        return data?.signedUrl ?? null;
      })
    );
    documentsForSelected = [
      ...(signedFileUrl
        ? [
            {
              name: selected.file_name,
              url: signedFileUrl,
              isPdf: isPdfName(selected.file_name),
              isImage: isImageName(selected.file_name),
            },
          ]
        : []),
      ...attachmentRows.map((d, i) => ({
        name: d.file_name,
        url: attachmentUrls[i] ?? null,
        isPdf: isPdfName(d.file_name),
        isImage: isImageName(d.file_name),
      })),
    ];

    // Resolve comment/audit-actor names (profiles RLS lets org members read
    // each other since migration 0002).
    const authorIds = [
      ...new Set(
        [
          ...commentsForSelected.map((c) => c.author_id),
          ...auditEntriesForSelected.map((a) => a.actor_id),
        ].filter((id): id is string => !!id)
      ),
    ];
    const { data: authors } =
      authorIds.length > 0
        ? await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", authorIds)
        : { data: [] };
    authorNameById = new Map(
      (authors ?? []).map((a) => [a.id, a.full_name ?? "Team member"])
    );

    // Accounting-instructions thread (append-only; becomes the QBO memo).
    const { data: instrRows } = await supabase
      .from("accounting_instructions")
      .select("id, author_id, body, created_at")
      .eq("invoice_id", selected.id)
      .order("created_at", { ascending: true });
    const instrAuthorIds = [
      ...new Set(
        (instrRows ?? [])
          .map((r) => r.author_id)
          .filter((id): id is string => !!id)
      ),
    ];
    const { data: instrProfiles } =
      instrAuthorIds.length > 0
        ? await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", instrAuthorIds)
        : { data: [] };
    const instrNameById = new Map(
      (instrProfiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
    );
    instructionEntriesForSelected = (instrRows ?? []).map((r) => ({
      id: r.id,
      authorName: r.author_id
        ? (instrNameById.get(r.author_id) ?? "Team member")
        : "System",
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  const projectNameById = new Map(
    (projects ?? []).map((p) => [p.id, p.name])
  );

  const auditTimelineForSelected = buildAuditTimeline({
    auditEntries: auditEntriesForSelected,
    comments: commentsForSelected,
    nameOf: (id) => (id ? authorNameById.get(id) ?? "Team member" : "System"),
    // Show project names, not UUIDs, in change details.
    idName: (id) => projectNameById.get(id),
  });

  const currentStepApprovers = selected ? holderOf(selected) : [];
  // Only an approver actually required for the current step sees the
  // buttons; the server action enforces the same rule regardless of what
  // the UI shows.
  const canDecide =
    selected != null &&
    selected.status === "on_approval" &&
    selected.workflow_id !== null &&
    currentStepApprovers.includes(user.id);

  // The approver who put an invoice on hold can resume it — on hold the
  // whole action row collapses to a single "Unhold" button.
  const canUnhold =
    selected != null &&
    selected.status === "on_hold" &&
    selected.workflow_id !== null &&
    currentStepApprovers.includes(user.id);

  // Per step_order, has that step's required approver(s) resolved it yet
  // — for the ApprovalStepper display. Mirrors holderOf's own logic per
  // step rather than just the current one.
  const stepStatesForSelected = new Map<number, "pending" | "approved" | "rejected">();
  if (selected) {
    const decisionsByStep = new Map<
      number,
      { approver_id: string | null; decision: string }[]
    >();
    for (const a of approvalsForSelected) {
      const list = decisionsByStep.get(a.step_order) ?? [];
      list.push({ approver_id: a.approver_id, decision: a.decision });
      decisionsByStep.set(a.step_order, list);
    }
    for (const step of stepsForSelected) {
      const approvers = stepApproversByStepId.get(step.id) ?? [];
      const conditions = approvers.flatMap(
        (a) => conditionsByStepApproverId.get(a.id) ?? []
      );
      const required =
        selected.step_override_approver_id && step.step_order === selected.current_step_order
          ? [selected.step_override_approver_id]
          : effectiveApproversForStep(
              approvers,
              conditions,
              { vendor_name: selected.vendor_name, project_id: selected.project_id },
              lineItemsForSelected.map((li) => ({
                class: li.class,
                category: li.category,
                project_id: li.project_id,
              }))
            );
      stepStatesForSelected.set(
        step.step_order,
        stepDecisionState(
          step.approval_mode,
          required,
          decisionsByStep.get(step.step_order) ?? []
        )
      );
    }
  }

  // The submitter can withdraw their own not-yet-decided invoice; an admin
  // can cancel anyone's.
  const canCancel =
    selected != null &&
    (selected.status === "on_review" ||
      selected.status === "on_approval" ||
      selected.status === "on_hold") &&
    (selected.submitted_by === user.id || canReviewNow);

  const navItems: { key: View; label: string }[] = [
    { key: "all", label: "All invoices" },
    ...(canSeeReviewQueue
      ? [{ key: "review" as View, label: "Pending Review" }]
      : []),
    { key: "mine", label: "Requires my approval" },
    ...(canReviewNow ? [{ key: "ready" as View, label: "QBO Ready" }] : []),
    { key: "created", label: "Created by me" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <DocumentFocusProvider>
    <ExtractionPoller />
    <div className="flex h-screen bg-slate-50 text-slate-900">
      {/* Sidebar (collapsible via hamburger) */}
      <Sidebar>
        <div className="border-b border-slate-200 p-4">
          <div className="text-sm font-semibold">{org.name}</div>
          <div className="mt-0.5 truncate text-xs text-slate-400" title={`${org.inbound_email_local ?? org.inbound_email_token}@${process.env.INBOUND_EMAIL_DOMAIN}`}>
            {org.inbound_email_local ?? org.inbound_email_token}@{process.env.INBOUND_EMAIL_DOMAIN}
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {navItems.map((item) => (
            <Link
              key={item.key}
              href={`/dashboard${item.key === "all" ? "" : `?view=${item.key}`}`}
              className={clsx(
                "flex items-center justify-between rounded-md px-3 py-2 text-sm",
                view === item.key
                  ? "bg-blue-50 font-medium text-blue-700"
                  : "text-slate-600 hover:bg-slate-100"
              )}
            >
              {item.label}
              <span
                className={clsx(
                  "rounded-full px-1.5 py-0.5 text-xs",
                  view === item.key ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"
                )}
              >
                {counts[item.key]}
              </span>
            </Link>
          ))}
          {canReviewNow && (
            <div className="mt-2 border-t border-slate-100 pt-2">
              <Link
                href="/queue"
                className="flex items-center rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
              >
                Queue
              </Link>
            </div>
          )}
        </nav>
        <div className="border-t border-slate-200 p-2">
          {unreadNotificationsCount > 0 && (
            <Link
              href="/notifications"
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-blue-700 hover:bg-blue-50"
            >
              <span className="flex items-center gap-2">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                Mentions
              </span>
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                {unreadNotificationsCount}
              </span>
            </Link>
          )}
          {pendingSplitsCount > 0 && (
            <Link
              href="/invoices/pending-splits"
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-orange-700 hover:bg-orange-50"
            >
              <span className="flex items-center gap-2">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6M9 15l2 2 4-4" />
                </svg>
                Needs split review
              </span>
              <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700">
                {pendingSplitsCount}
              </span>
            </Link>
          )}
          <Link
            href="/workflows"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
            </svg>
            Workflows
          </Link>
          <Link
            href="/reports"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 3 3 5-6" />
            </svg>
            Reports
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </Link>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 p-4">
          <span className="truncate text-xs text-slate-500">{user.email}</span>
          <SignOutButton />
        </div>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex flex-none items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="w-80">
            <SearchInput defaultValue={q} />
          </div>
          <DocumentSearchModal
            statuses={STATUS_OPTIONS}
            members={memberOptions}
            vendors={vendorOptions}
            projects={projectOptions}
            classes={classOptions}
            initial={advanced}
            activeCount={activeFilterCount}
          />
          <div className="flex-1" />
          {canReviewNow && (
            <Link
              href="/queue"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Queue
            </Link>
          )}
          {!isAuditor && (
            <Link
              href="/invoices/new"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              + Add invoice
            </Link>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          {/* List pane (collapsible) */}
          <CollapsiblePane title="Invoices">
            {filteredForDisplay.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No invoices in this view.
              </div>
            ) : (
              filteredForDisplay.map((invoice, i) => (
                <div key={invoice.id}>
                  {i === 0 && pinnedDuplicates.length > 0 && (
                    <div className="flex items-center gap-1.5 border-b border-orange-200 bg-orange-50 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path
                          d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Possible duplicates
                    </div>
                  )}
                  {i === pinnedDuplicates.length && pinnedDuplicates.length > 0 && (
                    <div className="border-b border-slate-200 bg-slate-50 px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      All invoices
                    </div>
                  )}
                  <Link
                    href={`/dashboard/${invoice.id}${qs}`}
                    className={clsx(
                      "block border-b border-slate-100 px-4 py-3",
                      duplicateInvoiceIds.has(invoice.id) && "border-l-2 border-l-orange-300",
                      selected?.id === invoice.id ? "bg-blue-50" : "hover:bg-slate-50"
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <div className="min-w-0 flex-1 truncate text-sm font-medium">
                        {invoice.vendor_name ?? invoice.file_name}
                      </div>
                      {duplicateInvoiceIds.has(invoice.id) && (
                        <span className="inline-flex flex-none items-center rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-800">
                          Duplicate
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-xs text-slate-500">
                        {invoice.amount != null
                          ? invoice.amount.toLocaleString(undefined, {
                              style: "currency",
                              currency: invoice.currency,
                            })
                          : "No amount extracted"}
                      </span>
                      <InvoiceStatusBadge status={invoice.status} />
                    </div>
                    {(() => {
                      const holderIds = holderOf(invoice);
                      return holderIds.length > 0 ? (
                        <div className="mt-1 text-xs text-slate-400">
                          With{" "}
                          {holderIds
                            .map((id) => memberNameById.get(id) ?? "Team member")
                            .join(", ")}
                        </div>
                      ) : null;
                    })()}
                  </Link>
                </div>
              ))
            )}
          </CollapsiblePane>

          {/* Detail pane: document viewer + bill panel + side panel */}
          <div className="flex min-w-0 flex-1">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                Select an invoice to view details.
              </div>
            ) : (
              <DetailSplit
                documents={documentsForSelected}
                uploadAction={addDocument.bind(null, selected.id)}
                canEdit={canEdit}
                bill={{
                  invoice: selected,
                  primaryFileUrl: signedFileUrl,
                  documentCount: documentsForSelected.length,
                  lineItems: lineItemsForSelected,
                  projects: (projects ?? []).map((p) => ({
                    id: p.id,
                    name: p.name,
                  })),
                  qboCategories: qboCategoryNames,
                  qboSuppliers: qboSupplierNames,
                  qboClasses: qboClassNames,
                  qboTaxRates: qboTaxCodeOptions.length > 0 ? qboTaxCodeOptions : qboTaxRateOptions,
                  qboTaxUsesCodes: qboTaxCodeOptions.length > 0,
                  qboSupplierDefaultTaxRates: qboSupplierDefaultTaxOptions,
                  saveBill: saveBill.bind(null, selected.id),
                  saveLineItem: saveLineItem.bind(null, selected.id),
                  deleteLineItem: deleteLineItem.bind(null, selected.id),
                  cloneLineItem: cloneLineItem.bind(null, selected.id),
                  reExtract: reExtract.bind(null, selected.id),
                  getPageCount: getInvoicePageCount,
                  reorderPages: reorderInvoicePages,
                  qboConnected: !!qboConnection,
                  qboRealmId: qboConnection?.realm_id ?? null,
                  backToReview: backToReview.bind(null, selected.id),
                  canReview: canReviewNow,
                  readOnly: !canEdit,
                  supplierDefaults: supplierDefaultsForSelected,
                  saveSupplierDefaults: saveSupplierDefaults.bind(
                    null,
                    selected.id,
                    selected.vendor_name ?? selected.file_name
                  ),
                  auditTimeline: auditTimelineForSelected,
                  comments: commentsForSelected,
                  authorNameById,
                  addComment: addComment.bind(null, selected.id),
                  members: memberOptions,
                  approval: {
                    currentStepApproverNames: currentStepApprovers.map(
                      (id) => memberNameById.get(id) ?? "Team member"
                    ),
                    steps: stepsForSelected,
                    stepStates: stepStatesForSelected,
                    canDecide,
                    canUnhold,
                    canCancel,
                    reviewComplete: reviewComplete.bind(null, selected.id),
                    hold: holdInvoice.bind(null, selected.id),
                    unhold: unholdInvoice.bind(null, selected.id),
                    reject: decide.bind(null, selected.id, "rejected"),
                    cancel: cancelInvoice.bind(null, selected.id),
                  },
                  admin: {
                    visible: canReviewNow,
                    showReassign:
                      selected.status === "on_approval" ||
                      selected.status === "on_hold",
                    reassignDefaultValue: selected.step_override_approver_id ?? "",
                    memberOptions,
                    reassign: reassignApprover.bind(null, selected.id),
                    statusOptions: STATUS_OPTIONS.map((s) => ({
                      value: s.id,
                      label: s.label,
                    })),
                    overrideStatus: overrideStatus.bind(null, selected.id),
                    deleteInvoice: deleteInvoiceAction.bind(null, selected.id),
                    syncToQbo: syncToQbo.bind(null, selected.id),
                    clearQboError: clearQboError.bind(null, selected.id),
                    clearQboSync: clearQboSync.bind(null, selected.id),
                  },
                  instructions: {
                    entries: instructionEntriesForSelected,
                    readOnly: isAuditor,
                    saveInstructions: saveAccountingInstructions.bind(
                      null,
                      selected.id
                    ),
                    approve: canDecide
                      ? decide.bind(null, selected.id, "approved")
                      : undefined,
                  },
                  alerts: (
                    <>
                      {searchParams.error && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                          {DECISION_ERRORS[searchParams.error] ??
                            "That action could not be completed."}
                        </div>
                      )}

                      {possibleDuplicates.length > 0 && (
                        <div className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
                          <p className="font-medium">
                            Possible duplicate — invoice #{selected!.invoice_number} from{" "}
                            {selected!.vendor_name} already exists.
                          </p>
                          <ul className="mt-1.5 space-y-1">
                            {possibleDuplicates.map((d) => (
                              <li key={d.id}>
                                <Link
                                  href={`/dashboard/${d.id}${qs}`}
                                  className="underline hover:no-underline"
                                >
                                  <LocalTime iso={d.created_at} dateOnly /> —{" "}
                                  {d.amount != null
                                    ? d.amount.toLocaleString(undefined, {
                                        style: "currency",
                                        currency: d.currency,
                                      })
                                    : "no amount"}
                                </Link>
                                {d.amount !== selected!.amount && (
                                  <span className="ml-1 text-xs text-orange-700">
                                    (amount differs from this one — possible price-corrected
                                    resubmission, not necessarily a true duplicate)
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
    </DocumentFocusProvider>
  );
}
