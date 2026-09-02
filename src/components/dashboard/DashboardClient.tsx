"use client";

// Phase 2: the client-cached rewrite of the Dashboard's master-detail
// view. Clicking a different invoice updates `selectedId` (React state)
// instead of triggering a Next.js navigation — the detail query is keyed
// by id, so a previously-opened invoice renders instantly from cache
// with zero network request, and a new one only pays for its own detail
// fetch (not the whole page). The invoice list itself is fetched once
// and reused across every click.
//
// Mutations still call the exact same "use server" actions as before
// (imported unchanged from dashboard-actions.ts) — this file only wraps
// each one so it also invalidates the relevant query key on success,
// since a Server Action's own revalidatePath() has no way to reach a
// separate client-side query cache.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { clsx } from "clsx";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { SearchInput } from "@/components/SearchInput";
import { CollapsiblePane } from "@/components/CollapsiblePane";
import { InvoiceSelectionList, type SelectableInvoice } from "@/components/InvoiceSelectionList";
import { DetailSplit } from "@/components/DetailSplit";
import { AppSidebar } from "@/components/AppSidebar";
import { DocumentFocusProvider } from "@/components/DocumentFocusContext";
import { ToastProvider } from "@/components/ToastContext";
import { ExtractionPoller } from "@/components/ExtractionPoller";
import { UpdateAvailableBanner } from "@/components/UpdateAvailableBanner";
import { TrialBanner } from "@/components/TrialBanner";
import { LocalTime } from "@/components/LocalTime";
import { DocumentSearchModal } from "@/components/DocumentSearchModal";
import type { MultiSelectOption } from "@/components/MultiSelect";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { switchOrgAction } from "@/lib/admin-actions";
import { buildAuditTimeline } from "@/lib/audit-timeline";
import {
  fetchDashboardListData,
  markNotificationReadForDashboard,
  type DashboardListData,
  type InvoiceDetailData,
} from "@/lib/dashboard-data";
import {
  VIEWS,
  type View,
  type AdvancedFilters,
  emptyAdvancedFilters,
  buildLookups,
  buildDuplicateGroups,
  holderOf,
  visibleInvoicesFor,
  applyViewAndFilters,
  pinDuplicatesForDisplay,
  computeCounts,
  vendorOptionsFor,
  classOptionsFor,
  duplicateGroupKey,
  stepDecisionState,
} from "@/lib/dashboard-computations";
import {
  backToReview,
  cancelInvoice,
  decide,
  rejectWithReason,
  addComment,
  addDocument,
  saveAccountingInstructions,
  saveBill,
  saveSupplierDefaults,
  reviewComplete,
  holdInvoice,
  unholdInvoice,
  deleteInvoiceAction,
  deleteInvoicesAction,
  clearQboPublishDataAction,
  emailInvoicesAction,
  reassignApprover,
  setInvoiceStage,
  overrideStatus,
  saveLineItem,
  deleteLineItem,
  cloneLineItem,
  collapseInvoiceToOneLine,
  reExtract,
  getInvoicePageCount,
  reorderInvoicePages,
  syncToQbo,
  clearQboError,
  clearQboSync,
} from "@/lib/dashboard-actions";
import { effectiveApproversForStep } from "@/lib/workflow-conditions";

const STATUS_OPTIONS: MultiSelectOption[] = [
  { id: "on_review", label: "On review" },
  { id: "on_approval", label: "On approval" },
  { id: "approved", label: "Approved" },
  { id: "qbo_ready", label: "QBO Ready" },
  { id: "on_hold", label: "On hold" },
  { id: "rejected", label: "Rejected" },
  { id: "cancelled", label: "Cancelled" },
];

const DECISION_ERRORS: Record<string, string> = {
  "not-your-step": "Only the approver assigned to the current step can approve or reject this invoice.",
  "already-decided": "This invoice has already been decided at this step.",
  "step-required": "Earlier approval steps must be completed before this step can be decided.",
  "reject-reason-required": "A reason is required to reject an invoice.",
  "trial-locked": "Your trial has ended — choose a plan on the Billing page to keep approving invoices.",
};

function csvParam(value: string | null): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

// Reads the initial view/filters/selected-id from the real URL once, on
// mount — after that, this component owns navigation state itself and
// keeps the URL in sync via history.replaceState (not next/navigation's
// router, which would trigger a server round trip for every click).
function readUrlState() {
  const sp = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  const idFromPath = path.startsWith("/dashboard/") ? path.slice("/dashboard/".length) : "";
  return {
    selectedId: idFromPath || null,
    n: sp.get("n"),
    view: (VIEWS.includes(sp.get("view") as View) ? (sp.get("view") as View) : "all") as View,
    q: sp.get("q") ?? "",
    docOpen: sp.get("doc") === "1",
    advanced: {
      status: csvParam(sp.get("status")),
      holder: csvParam(sp.get("holder")),
      requester: csvParam(sp.get("requester")),
      approvedBy: csvParam(sp.get("approvedBy")),
      supplier: csvParam(sp.get("supplier")),
      customer: csvParam(sp.get("customer")),
      class: csvParam(sp.get("class")),
      number: sp.get("number") ?? "",
      dateFrom: sp.get("dateFrom") ?? "",
      dateTo: sp.get("dateTo") ?? "",
      amountFrom: sp.get("amountFrom") ?? "",
      amountTo: sp.get("amountTo") ?? "",
    } satisfies AdvancedFilters,
    error: sp.get("error"),
  };
}

// SearchInput and DocumentSearchModal both build a relative "/dashboard?..."
// URL internally (voice search, AI natural-language search, and the advanced
// filter modal all funnel through this). Phase 2 intercepts that via
// onNavigate instead of letting them call next/navigation's router — this
// parses the query string back into local state. Mirrors the pre-Phase-2
// behavior of a fresh /dashboard?... navigation: view resets to "all" and
// the open invoice is cleared, since neither component's URL ever carries a
// view or an id path segment.
function parseFilterUrl(url: string): { q: string; advanced: AdvancedFilters } {
  const qIdx = url.indexOf("?");
  const sp = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
  return {
    q: sp.get("q") ?? "",
    advanced: {
      status: csvParam(sp.get("status")),
      holder: csvParam(sp.get("holder")),
      requester: csvParam(sp.get("requester")),
      approvedBy: csvParam(sp.get("approvedBy")),
      supplier: csvParam(sp.get("supplier")),
      customer: csvParam(sp.get("customer")),
      class: csvParam(sp.get("class")),
      number: sp.get("number") ?? "",
      dateFrom: sp.get("dateFrom") ?? "",
      dateTo: sp.get("dateTo") ?? "",
      amountFrom: sp.get("amountFrom") ?? "",
      amountTo: sp.get("amountTo") ?? "",
    },
  };
}

// A plain fetch() to a Route Handler, not a direct call to the
// "use server" fetchInvoiceDetail — see api/dashboard/invoice/[id]/route.ts
// for why: detail reads are warmed client-side for likely next clicks and
// a Server Action call, even a pure read, makes Next's router refetch/remount
// whatever route it still thinks is mounted.
async function fetchInvoiceDetailViaApi(id: string): Promise<InvoiceDetailData> {
  const res = await fetch(`/api/dashboard/invoice/${id}`);
  if (!res.ok) throw new Error(`Failed to load invoice ${id}`);
  return res.json();
}

const LIST_STALE_MS = 30 * 1000;
const DETAIL_STALE_MS = 2 * 60 * 1000;

type InvoiceListRow = DashboardListData["invoices"][number];

function InvoiceDetailLoading({ invoice }: { invoice: InvoiceListRow }) {
  const amount =
    invoice.amount != null
      ? invoice.amount.toLocaleString(undefined, { style: "currency", currency: invoice.currency })
      : "Amount pending";
  return (
    <div className="flex flex-1 items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-elevation-1">
        <div className="border-b border-slate-100 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Opening invoice</div>
              <div className="mt-1 truncate text-lg font-semibold text-slate-900">
                {invoice.vendor_name ?? invoice.file_name}
              </div>
              {invoice.invoice_number && <div className="mt-1 text-xs text-slate-500">#{invoice.invoice_number}</div>}
            </div>
            <div className="flex-none text-right">
              <div className="text-xl font-bold tabular-nums text-slate-900">{amount}</div>
              <InvoiceStatusBadge status={invoice.status} />
            </div>
          </div>
        </div>
        <div className="space-y-4 px-6 py-5">
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-2 w-14 rounded-full bg-slate-100" />
                <div className="h-8 rounded-md bg-slate-100" />
              </div>
            ))}
          </div>
          <div className="h-20 rounded-lg bg-slate-100" />
          <div className="space-y-2">
            <div className="h-3 w-28 rounded-full bg-slate-100" />
            <div className="h-10 rounded-lg bg-slate-100" />
            <div className="h-10 rounded-lg bg-slate-100" />
          </div>
        </div>
      </div>
    </div>
  );
}

function InvoiceDetailUnavailable({ invoice, error }: { invoice: InvoiceListRow; error?: unknown }) {
  const message = error instanceof Error ? error.message : "The invoice details could not be loaded.";
  return (
    <div className="flex flex-1 items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md rounded-xl border border-rose-100 bg-white p-6 text-center shadow-elevation-1">
        <div className="text-sm font-semibold text-slate-900">Couldn&apos;t open this invoice</div>
        <p className="mt-2 text-sm text-slate-500">
          {invoice.vendor_name ?? invoice.file_name} is still in the list, but its full detail record did not load.
        </p>
        <p className="mt-3 text-xs text-rose-600">{message}</p>
      </div>
    </div>
  );
}

export function DashboardClient({ initialListData }: { initialListData: DashboardListData }) {
  const queryClient = useQueryClient();
  const orgId = initialListData.org.id;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [advanced, setAdvanced] = useState<AdvancedFilters>(emptyAdvancedFilters());
  const [docOpen, setDocOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialSupportOpen, setInitialSupportOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Restore state from the URL exactly once (deep link / email link /
  // browser refresh) — everything after this is pure client navigation.
  useEffect(() => {
    const s = readUrlState();
    setSelectedId(s.selectedId);
    setView(s.view);
    setQ(s.q);
    setAdvanced(s.advanced);
    setDocOpen(s.docOpen);
    setError(s.error);
    setInitialSupportOpen(new URLSearchParams(window.location.search).get("openSupport") === "1");
    if (s.n) {
      markNotificationReadForDashboard(s.n).catch(() => {});
    }
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the address bar truthful (bookmarking, sharing, browser back/
  // forward) without ever asking Next's router to fetch anything.
  useEffect(() => {
    if (!mounted) return;
    const qsObj = new URLSearchParams();
    if (view !== "all") qsObj.set("view", view);
    if (q) qsObj.set("q", q);
    if (advanced.status.length) qsObj.set("status", advanced.status.join(","));
    if (advanced.holder.length) qsObj.set("holder", advanced.holder.join(","));
    if (advanced.requester.length) qsObj.set("requester", advanced.requester.join(","));
    if (advanced.approvedBy.length) qsObj.set("approvedBy", advanced.approvedBy.join(","));
    if (advanced.supplier.length) qsObj.set("supplier", advanced.supplier.join(","));
    if (advanced.customer.length) qsObj.set("customer", advanced.customer.join(","));
    if (advanced.class.length) qsObj.set("class", advanced.class.join(","));
    if (advanced.number) qsObj.set("number", advanced.number);
    if (advanced.dateFrom) qsObj.set("dateFrom", advanced.dateFrom);
    if (advanced.dateTo) qsObj.set("dateTo", advanced.dateTo);
    if (advanced.amountFrom) qsObj.set("amountFrom", advanced.amountFrom);
    if (advanced.amountTo) qsObj.set("amountTo", advanced.amountTo);
    if (docOpen) qsObj.set("doc", "1");
    const qsStr = qsObj.toString();
    const path = selectedId ? `/dashboard/${selectedId}` : "/dashboard";
    const url = qsStr ? `${path}?${qsStr}` : path;
    window.history.replaceState(null, "", url);
  }, [mounted, selectedId, view, q, advanced, docOpen]);

  const listQuery = useQuery({
    queryKey: ["dashboard-list", orgId],
    queryFn: fetchDashboardListData,
    initialData: initialListData,
    staleTime: LIST_STALE_MS,
  });
  const data = listQuery.data;

  // Mirrors the "no explicit selection" fallback below (selectedId ||
  // filtered[0]) — computed up front so the detail query is keyed on the
  // invoice that's actually showing, not just an explicit URL/click
  // selection. Without this, landing on the dashboard with no id in the
  // URL left detailQuery permanently disabled (queryKey/enabled both keyed
  // on the null selectedId) even though the UI silently defaulted the
  // right pane to the first filtered invoice — stuck on "Loading…" forever.
  const lookups = useMemo(() => buildLookups(data), [data]);
  const visibleInvoicesForQuery = useMemo(() => visibleInvoicesFor(data, lookups), [data, lookups]);
  const filteredForQuery = useMemo(
    () => applyViewAndFilters(visibleInvoicesForQuery, view, q, advanced, lookups, data.user.id),
    [visibleInvoicesForQuery, view, q, advanced, lookups, data.user.id]
  );
  const effectiveSelectedId = selectedId ?? filteredForQuery[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ["invoice-detail", effectiveSelectedId],
    queryFn: () => fetchInvoiceDetailViaApi(effectiveSelectedId!),
    enabled: !!effectiveSelectedId,
    staleTime: DETAIL_STALE_MS,
  });

  const handleSearchNavigate = useCallback((url: string) => {
    const parsed = parseFilterUrl(url);
    setSelectedId(null);
    setView("all");
    setQ(parsed.q);
    setAdvanced(parsed.advanced);
  }, []);

  const invalidateAfter = useCallback(
    <T extends unknown[], R>(fn: (...args: T) => Promise<R>) =>
      async (...args: T): Promise<R> => {
        const result = await fn(...args);
        // Awaited (invalidateQueries' own promise resolves once its
        // refetch completes) rather than fire-and-forget: two mutations
        // on the same invoice close together — e.g. reassign then
        // override status — otherwise race. The second one's invalidate
        // could land while the first's refetch is still in flight; React
        // Query treats the key as already being fetched and doesn't
        // start a second one, so the in-flight fetch's now-stale-relative-
        // to-the-second-mutation result becomes the final cached value,
        // with nothing left to trigger a further refetch. Awaiting keeps
        // each mutation's refetch fully resolved before the next one's
        // action even starts.
        await queryClient.invalidateQueries({ queryKey: ["dashboard-list", orgId] });
        // Must match detailQuery's own key (effectiveSelectedId, not the
        // raw selectedId state) — otherwise a mutation made while viewing
        // the fallback-to-first-invoice case (no explicit click/URL id
        // yet) silently invalidates nothing: it writes to the database
        // fine, but the open invoice never refetches to show it.
        if (effectiveSelectedId) await queryClient.invalidateQueries({ queryKey: ["invoice-detail", effectiveSelectedId] });
        return result;
      },
    [queryClient, orgId, effectiveSelectedId]
  );

  const org = data.org;
  const user = data.user;
  const isAuditor = org.role === "auditor";
  const canReviewNow = org.role === "admin";
  const canSeeReviewQueue = org.role === "admin" || isAuditor;
  const canEdit = org.role === "admin";

  const { duplicateGroups, duplicateInvoiceIds } = useMemo(() => buildDuplicateGroups(data.invoices), [data.invoices]);
  const visibleInvoices = visibleInvoicesForQuery;
  const filtered = filteredForQuery;
  const filteredForDisplay = useMemo(
    () => pinDuplicatesForDisplay(filtered, duplicateInvoiceIds),
    [filtered, duplicateInvoiceIds]
  );
  const counts = useMemo(() => computeCounts(visibleInvoices, lookups, user.id), [visibleInvoices, lookups, user.id]);
  const vendorOptions = useMemo(() => vendorOptionsFor(data.invoices), [data.invoices]);
  const classOptions = useMemo(() => classOptionsFor(data.lineItemRows), [data.lineItemRows]);
  const projectOptions: MultiSelectOption[] = useMemo(
    () => data.projects.map((p) => ({ id: p.id, label: p.name })),
    [data.projects]
  );
  const memberOptions: MultiSelectOption[] = useMemo(
    () =>
      data.memberUserIds
        .map((id) => ({ id, label: data.memberNameById[id] ?? "Team member" }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [data.memberNameById, data.memberUserIds]
  );

  const selected = selectedId ? visibleInvoices.find((i) => i.id === selectedId) ?? null : filtered[0] ?? null;
  const selectedNotFound = !!selectedId && !selected;

  const activeFilterCount =
    [advanced.status, advanced.holder, advanced.requester, advanced.approvedBy, advanced.supplier, advanced.customer, advanced.class].filter(
      (a) => a.length > 0
    ).length +
    [advanced.number, advanced.dateFrom, advanced.dateTo, advanced.amountFrom, advanced.amountTo].filter(Boolean).length;

  const selectedDisplayIndex = filteredForDisplay.findIndex((i) => i.id === selected?.id);
  const prevInvoice = selectedDisplayIndex > 0 ? filteredForDisplay[selectedDisplayIndex - 1] : null;
  const nextInvoice =
    selectedDisplayIndex !== -1 && selectedDisplayIndex < filteredForDisplay.length - 1
      ? filteredForDisplay[selectedDisplayIndex + 1]
      : null;
  const nextInvoiceIdAfterDelete = nextInvoice?.id ?? prevInvoice?.id ?? null;

  // Intentional detail warming: invoice detail loads are fairly heavy, so
  // scrolling alone should not enqueue them. Warm only rows the user hovers/
  // focuses and the immediate prev/next neighbors of the open invoice.
  const prefetchInvoiceDetail = useCallback(
    (id: string | null | undefined) => {
      if (!id || id === effectiveSelectedId) return;
      void queryClient.prefetchQuery({
        queryKey: ["invoice-detail", id],
        queryFn: () => fetchInvoiceDetailViaApi(id),
        staleTime: DETAIL_STALE_MS,
      });
    },
    [effectiveSelectedId, queryClient]
  );

  useEffect(() => {
    prefetchInvoiceDetail(prevInvoice?.id);
    prefetchInvoiceDetail(nextInvoice?.id);
  }, [nextInvoice?.id, prefetchInvoiceDetail, prevInvoice?.id]);

  const possibleDuplicates = useMemo(() => {
    if (!selected) return [];
    const key = duplicateGroupKey(selected);
    if (!key) return [];
    return (duplicateGroups.get(key) ?? []).filter((i) => i.id !== selected.id);
  }, [selected, duplicateGroups]);

  const mentionableMemberOptions: MultiSelectOption[] = useMemo(() => {
    if (!selected) return [];
    const ids = new Set<string>();
    for (const step of data.allSteps) {
      if (step.workflow_id !== selected.workflow_id) continue;
      const approvers = lookups.stepApproversByStepId.get(step.id) ?? [];
      const conditions = approvers.flatMap((a) => lookups.conditionsByStepApproverId.get(a.id) ?? []);
      const effective = effectiveApproversForStep(
        approvers,
        conditions,
        { vendor_name: selected.vendor_name, project_id: selected.project_id },
        lookups.lineItemsByInvoiceForMatching.get(selected.id) ?? []
      );
      for (const id of effective) ids.add(id);
    }
    for (const id of data.adminUserIds) ids.add(id);
    if (selected.submitted_by) ids.add(selected.submitted_by);
    return memberOptions.filter((m) => ids.has(m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, data.allSteps, data.adminUserIds, lookups, memberOptions]);

  const currentStepApprovers = selected ? holderOf(selected, lookups) : [];
  const detail = detailQuery.data;
  const stepsForSelected = useMemo(
    () => (selected ? data.allSteps.filter((s) => s.workflow_id === selected.workflow_id) : []),
    [selected, data.allSteps]
  );

  const canDecide =
    selected != null && selected.status === "on_approval" && selected.workflow_id !== null && currentStepApprovers.includes(user.id);
  const canUnhold =
    selected != null && selected.status === "on_hold" && selected.workflow_id !== null && currentStepApprovers.includes(user.id);
  const canCancel =
    selected != null &&
    (selected.status === "on_review" || selected.status === "on_approval" || selected.status === "on_hold") &&
    (selected.submitted_by === user.id || canReviewNow);

  const hasCurrentUserApprovedSelected =
    !!detail && detail.approvals.some((a) => a.approver_id === user.id && a.decision === "approved");
  const lockedForPlainUser = org.role === "user" && hasCurrentUserApprovedSelected;
  const classReadOnly = isAuditor || lockedForPlainUser || (org.role === "user" && !canDecide);
  const canComment = !isAuditor;

  const stepStatesForSelected = useMemo(() => {
    const map = new Map<number, "pending" | "approved" | "rejected">();
    if (!selected || !detail) return map;
    const decisionsByStep = new Map<number, { approver_id: string | null; decision: string }[]>();
    for (const a of detail.approvals) {
      const list = decisionsByStep.get(a.step_order) ?? [];
      list.push({ approver_id: a.approver_id, decision: a.decision });
      decisionsByStep.set(a.step_order, list);
    }
    for (const step of stepsForSelected) {
      const approvers = lookups.stepApproversByStepId.get(step.id) ?? [];
      const conditions = approvers.flatMap((a) => lookups.conditionsByStepApproverId.get(a.id) ?? []);
      const required =
        selected.step_override_approver_id && step.step_order === selected.current_step_order
          ? [selected.step_override_approver_id]
          : effectiveApproversForStep(
              approvers,
              conditions,
              { vendor_name: selected.vendor_name, project_id: selected.project_id },
              detail.lineItems.map((li) => ({ class: li.class, category: li.category, project_id: li.project_id }))
            );
      map.set(step.step_order, stepDecisionState(step.approval_mode, required, decisionsByStep.get(step.step_order) ?? []));
    }
    return map;
  }, [selected, detail, stepsForSelected, lookups]);

  const projectNameById = useMemo(() => new Map(data.projects.map((p) => [p.id, p.name])), [data.projects]);
  const auditTimelineForSelected = useMemo(
    () =>
      detail
        ? buildAuditTimeline({
            auditEntries: detail.auditEntries,
            comments: detail.comments,
            nameOf: (id) => (id ? detail.authorNameById[id] ?? "Team member" : "System"),
            idName: (id) => projectNameById.get(id),
          })
        : [],
    [detail, projectNameById]
  );
  const qboCategoryNames = useMemo(
    () =>
      [...new Set(data.qboCategoryRows.map((c) => (c.acct_num ? `${c.acct_num} - ${c.name}` : c.name)))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [data.qboCategoryRows]
  );
  const qboSupplierNames = useMemo(
    () => [...new Set(data.qboSupplierRows.map((s) => s.name))].sort((a, b) => a.localeCompare(b)),
    [data.qboSupplierRows]
  );
  const qboClassNames = useMemo(
    () => [...new Set(data.qboClassRows.map((c) => c.name))].sort((a, b) => a.localeCompare(b)),
    [data.qboClassRows]
  );
  const qboTaxRateOptions = useMemo(
    () => data.qboTaxRateRows.map((r) => ({ value: String(r.rate_value), label: `${r.rate_value}% — ${r.name}` })),
    [data.qboTaxRateRows]
  );
  const qboTaxCodeOptions = useMemo(
    () =>
      data.qboTaxCodeRows
        .filter((c) => c.rate_value != null)
        .map((c) => ({ value: c.qbo_tax_code_id, label: `${c.name} (${c.rate_value}%)`, secondaryValue: String(c.rate_value) })),
    [data.qboTaxCodeRows]
  );
  const qboTaxCodeRateOnlyOptions = useMemo(
    () =>
      data.qboTaxCodeRows
        .filter((c) => c.rate_value != null)
        .map((c) => ({ value: String(c.rate_value), label: `${c.name} (${c.rate_value}%)` })),
    [data.qboTaxCodeRows]
  );
  const qboSupplierDefaultTaxOptions = qboTaxCodeRateOnlyOptions.length > 0 ? qboTaxCodeRateOnlyOptions : qboTaxRateOptions;

  const navItems: { key: View; label: string }[] = useMemo(
    () => [
      { key: "all", label: "All invoices" },
      ...(canSeeReviewQueue ? [{ key: "review" as View, label: "Pending Review" }] : []),
      { key: "mine", label: "Requires my approval" },
      ...(canReviewNow ? [{ key: "ready" as View, label: "QBO Ready" }] : []),
      { key: "created", label: "Created by me" },
      { key: "approved", label: "Approved" },
      { key: "rejected", label: "Rejected" },
    ],
    [canReviewNow, canSeeReviewQueue]
  );

  const selectableRows: SelectableInvoice[] = useMemo(
    () =>
      filteredForDisplay.map((inv) => ({
        id: inv.id,
        vendor: inv.vendor_name ?? inv.file_name,
        amount: inv.amount,
        invoiceNumber: inv.invoice_number,
        currency: inv.currency,
        status: inv.status,
        isDuplicate: duplicateInvoiceIds.has(inv.id),
        holders: holderOf(inv, lookups).map((id) => data.memberNameById[id] ?? "Team member"),
        selected: selected?.id === inv.id,
        qboBillId: inv.qbo_sync_status === "synced" ? inv.qbo_bill_id : null,
      })),
    [data.memberNameById, duplicateInvoiceIds, filteredForDisplay, lookups, selected?.id]
  );

  if (!mounted) return null;

  return (
    <ToastProvider>
      <DocumentFocusProvider>
        <ExtractionPoller onProcessed={() => queryClient.invalidateQueries({ queryKey: ["dashboard-list", orgId] })} />
        <UpdateAvailableBanner />
        <TrialBanner
          org={{
            plan: data.trialPlan,
            custom_plan: data.trialCustomPlan,
            trial_ends_at: data.trialEndsAt,
          }}
        />
        <div className="flex h-screen bg-slate-50 text-slate-900">
          <AppSidebar
            org={org}
            user={user}
            myOrgs={data.myOrgs}
            switchOrgAction={switchOrgAction}
            isPlatformAdmin={isPlatformAdmin(user.email)}
            counts={{ mentions: data.unreadNotificationsCount, pendingSplits: data.pendingSplitsCount }}
            initialSupportOpen={initialSupportOpen}
          >
            <nav className="space-y-0.5">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setView(item.key)}
                  // This list and the app nav below it used to share the
                  // exact same green-tint active style, so the sidebar
                  // showed two "you are here" states at once (e.g. "All
                  // invoices" AND "Dashboard"). Green now means one thing —
                  // which page you're on — and the view filter uses a
                  // quieter selected treatment (brand surface + a green
                  // edge) for which slice you're looking at. The
                  // transparent border on every item keeps the label from
                  // shifting 2px when selection moves.
                  className={clsx(
                    "flex w-full items-center justify-between rounded-lg border-l-2 px-3 py-2 text-left text-sm transition-colors duration-150",
                    view === item.key
                      ? "border-brand-green bg-brand-mist font-semibold text-brand-ink"
                      : "border-transparent text-brand-muted hover:bg-brand-mist hover:text-brand-ink"
                  )}
                >
                  {item.label}
                  <span
                    className={clsx(
                      "rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                      view === item.key ? "bg-white text-brand-ink" : "bg-slate-100 text-slate-500"
                    )}
                  >
                    {counts[item.key]}
                  </span>
                </button>
              ))}
            </nav>
          </AppSidebar>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex flex-none items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
              <div className="w-80 lg:w-[32rem]">
                <SearchInput defaultValue={q} onNavigate={handleSearchNavigate} />
              </div>
              <DocumentSearchModal
                statuses={STATUS_OPTIONS}
                members={memberOptions}
                vendors={vendorOptions}
                projects={projectOptions}
                classes={classOptions}
                initial={advanced}
                activeCount={activeFilterCount}
                onNavigate={handleSearchNavigate}
              />
              <div className="flex-1" />
              {selected && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={!prevInvoice}
                    onClick={() => prevInvoice && setSelectedId(prevInvoice.id)}
                    title={prevInvoice ? `Previous: ${prevInvoice.vendor_name ?? prevInvoice.file_name}` : "No previous invoice"}
                    className={clsx(
                      "rounded-md border border-slate-300 p-2 text-slate-600",
                      prevInvoice ? "hover:bg-slate-50" : "pointer-events-none opacity-30"
                    )}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    disabled={!nextInvoice}
                    onClick={() => nextInvoice && setSelectedId(nextInvoice.id)}
                    title={nextInvoice ? `Next: ${nextInvoice.vendor_name ?? nextInvoice.file_name}` : "No next invoice"}
                    className={clsx(
                      "rounded-md border border-slate-300 p-2 text-slate-600",
                      nextInvoice ? "hover:bg-slate-50" : "pointer-events-none opacity-30"
                    )}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              )}
              {canReviewNow && (
                <Link href="/queue" className="rounded-md bg-brand-green px-4 py-2 text-sm font-medium text-white shadow-elevation-1 hover:bg-brand-green-dark">
                  Queue
                </Link>
              )}
              {!isAuditor && (
                <Link href="/invoices/new" className="rounded-md bg-brand-green px-4 py-2 text-sm font-medium text-white shadow-elevation-1 hover:bg-brand-green-dark">
                  + Add invoice
                </Link>
              )}
            </header>

            <div className="flex min-h-0 flex-1">
              <CollapsiblePane title="Invoices">
                <InvoiceSelectionList
                  rows={selectableRows}
                  pinnedCount={filtered.filter((i) => duplicateInvoiceIds.has(i.id)).length}
                  qs=""
                  canReview={canReviewNow}
                  deleteInvoicesAction={invalidateAfter(deleteInvoicesAction)}
                  clearQboPublishDataAction={invalidateAfter(clearQboPublishDataAction)}
                  emailInvoicesAction={emailInvoicesAction}
                  onSelect={(id) => {
                    prefetchInvoiceDetail(id);
                    setSelectedId(id);
                    setDocOpen(false);
                  }}
                  onRowIntent={prefetchInvoiceDetail}
                />
              </CollapsiblePane>

              <div className="flex min-w-0 flex-1">
                {selectedNotFound ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                    That invoice isn&apos;t available anymore.
                  </div>
                ) : !selected ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                    Select an invoice to view details.
                  </div>
                ) : detailQuery.isError ? (
                  <InvoiceDetailUnavailable invoice={selected} error={detailQuery.error} />
                ) : detailQuery.data === null && !detailQuery.isFetching ? (
                  <InvoiceDetailUnavailable invoice={selected} />
                ) : !detail ? (
                  <InvoiceDetailLoading invoice={selected} />
                ) : (
                  <DetailSplit
                    documents={detail.documents}
                    uploadAction={invalidateAfter(addDocument.bind(null, selected.id))}
                    canEdit={canEdit}
                    initialShowDoc={docOpen}
                    onDocOpenChange={setDocOpen}
                    bill={{
                      invoice: selected,
                      primaryFileUrl: detail.documents[0]?.url ?? null,
                      documentCount: detail.documents.length,
                      lineItems: detail.lineItems,
                      projects: data.projects,
                      qboCategories: qboCategoryNames,
                      qboSuppliers: qboSupplierNames,
                      qboClasses: qboClassNames,
                      qboTaxRates: qboTaxCodeOptions.length > 0 ? qboTaxCodeOptions : qboTaxRateOptions,
                      qboTaxUsesCodes: qboTaxCodeOptions.length > 0,
                      orgDefaultTaxRate: org.default_tax_rate,
                      orgDefaultTaxCodeId: org.default_tax_code_id,
                      qboSupplierDefaultTaxRates: qboSupplierDefaultTaxOptions,
                      saveBill: invalidateAfter(saveBill.bind(null, selected.id)),
                      saveLineItem: invalidateAfter(saveLineItem.bind(null, selected.id)),
                      deleteLineItem: invalidateAfter(deleteLineItem.bind(null, selected.id)),
                      cloneLineItem: invalidateAfter(cloneLineItem.bind(null, selected.id)),
                      collapseToOneLine: invalidateAfter(collapseInvoiceToOneLine.bind(null, selected.id)),
                      reExtract: invalidateAfter(reExtract.bind(null, selected.id)),
                      getPageCount: getInvoicePageCount,
                      reorderPages: invalidateAfter(reorderInvoicePages),
                      qboConnected: data.qboConnected,
                      qboRealmId: null,
                      backToReview: invalidateAfter(backToReview.bind(null, selected.id)),
                      canReview: canReviewNow,
                      readOnly: !canEdit,
                      classReadOnly,
                      canComment,
                      supplierDefaults: detail.supplierDefaults,
                      qboVendorId: detail.qboVendorId,
                      saveSupplierDefaults: invalidateAfter(
                        saveSupplierDefaults.bind(null, selected.id, selected.vendor_name ?? selected.file_name)
                      ),
                      auditTimeline: auditTimelineForSelected,
                      comments: detail.comments,
                      authorNameById: new Map(Object.entries(detail.authorNameById)),
                      addComment: invalidateAfter(addComment.bind(null, selected.id)),
                      members: mentionableMemberOptions,
                      approval: {
                        currentStepApproverNames: currentStepApprovers.map((id) => data.memberNameById[id] ?? "Team member"),
                        steps: stepsForSelected,
                        stepStates: stepStatesForSelected,
                        canDecide,
                        canUnhold,
                        canCancel,
                        reviewComplete: invalidateAfter(reviewComplete.bind(null, selected.id)),
                        hold: invalidateAfter(holdInvoice.bind(null, selected.id)),
                        unhold: invalidateAfter(unholdInvoice.bind(null, selected.id)),
                        reject: invalidateAfter(rejectWithReason.bind(null, selected.id)),
                        cancel: invalidateAfter(cancelInvoice.bind(null, selected.id)),
                      },
                      admin: {
                        visible: canReviewNow,
                        showReassign: selected.status === "on_approval" || selected.status === "on_hold",
                        reassignDefaultValue: selected.step_override_approver_id ?? "",
                        memberOptions,
                        reassign: invalidateAfter(reassignApprover.bind(null, selected.id)),
                        stageOptions: [...stepsForSelected]
                          .sort((a, b) => a.step_order - b.step_order)
                          .map((s) => ({ value: String(s.step_order), label: s.name ? `${s.step_order}. ${s.name}` : `Step ${s.step_order}` })),
                        stageDefaultValue: String(selected.current_step_order),
                        setStage: invalidateAfter(setInvoiceStage.bind(null, selected.id)),
                        statusOptions: STATUS_OPTIONS.map((s) => ({ value: s.id, label: s.label })),
                        overrideStatus: invalidateAfter(overrideStatus.bind(null, selected.id)),
                        deleteInvoice: invalidateAfter(deleteInvoiceAction.bind(null, selected.id, nextInvoiceIdAfterDelete, "")),
                        syncToQbo: invalidateAfter(syncToQbo.bind(null, selected.id)),
                        clearQboError: invalidateAfter(clearQboError.bind(null, selected.id)),
                        clearQboSync: invalidateAfter(clearQboSync.bind(null, selected.id)),
                      },
                      instructions: {
                        entries: detail.instructionEntries,
                        readOnly: isAuditor || lockedForPlainUser,
                        saveInstructions: invalidateAfter(saveAccountingInstructions.bind(null, selected.id)),
                        approve: canDecide ? invalidateAfter(decide.bind(null, selected.id, "approved")) : undefined,
                      },
                      alerts: (
                        <>
                          {error && (
                            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                              {DECISION_ERRORS[error] ?? "That action could not be completed."}
                            </div>
                          )}
                          {possibleDuplicates.length > 0 && (
                            <div className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
                              <p className="font-medium">
                                Possible duplicate — invoice #{selected.invoice_number} from {selected.vendor_name} already exists.
                              </p>
                              <ul className="mt-1.5 space-y-1">
                                {possibleDuplicates.map((d) => (
                                  <li key={d.id}>
                                    <button
                                      type="button"
                                      onClick={() => setSelectedId(d.id)}
                                      className="underline hover:no-underline"
                                    >
                                      <LocalTime iso={d.created_at} dateOnly /> —{" "}
                                      {d.amount != null
                                        ? d.amount.toLocaleString(undefined, { style: "currency", currency: d.currency })
                                        : "no amount"}
                                    </button>
                                    {d.amount !== selected.amount && (
                                      <span className="ml-1 text-xs text-orange-700">
                                        (amount differs from this one — possible price-corrected resubmission, not necessarily a true duplicate)
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
    </ToastProvider>
  );
}
