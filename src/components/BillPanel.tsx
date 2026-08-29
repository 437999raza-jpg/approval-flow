import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SupplierRulesModal, type SupplierDefaultsValues } from "./SupplierRulesModal";
import { Combobox } from "./Combobox";
import { CollapsibleSection } from "./CollapsibleSection";
import { MentionComposer } from "./MentionComposer";
import { ApprovalStepper } from "./ApprovalStepper";
import { InlineSelectSave } from "./InlineSelectSave";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";
import { SubmitButton } from "./SubmitButton";
import { InstructionsBox } from "./InstructionsBox";
import { LocalTime } from "./LocalTime";
import { ReorderPagesModal } from "./ReorderPagesModal";
import { RejectReasonModal } from "./RejectReasonModal";
import { useToast } from "./ToastContext";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import type { Database } from "@/lib/supabase/types";
import { computeLineItemTotals } from "@/lib/invoice-totals";
import { evaluateFormula } from "@/lib/formula";
import type { AuditTimelineEntry } from "@/lib/audit-timeline";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];
type LineItem = Database["public"]["Tables"]["invoice_line_items"]["Row"];
type Comment = Database["public"]["Tables"]["invoice_comments"]["Row"];
type WorkflowStep = Database["public"]["Tables"]["approval_workflow_steps"]["Row"];

export interface BillApprovalData {
  currentStepApproverNames: string[];
  steps: WorkflowStep[];
  stepStates: Map<number, "pending" | "approved" | "rejected">;
  canDecide: boolean;
  canUnhold: boolean;
  canCancel: boolean;
  reviewComplete: (formData: FormData) => Promise<void>;
  hold: (formData: FormData) => Promise<void>;
  unhold: (formData: FormData) => Promise<void>;
  reject: (formData: FormData) => Promise<void>;
  cancel: (formData: FormData) => Promise<void>;
}

export interface BillAdminData {
  visible: boolean;
  showReassign: boolean;
  reassignDefaultValue: string;
  memberOptions: { id: string; label: string }[];
  reassign: (formData: FormData) => Promise<void>;
  // Send the invoice straight to a specific workflow stage — works
  // regardless of current status (rejected, approved, on_review, …), unlike
  // overrideStatus's on_approval case which always restarts at step 1.
  stageOptions: { value: string; label: string }[];
  stageDefaultValue: string;
  setStage: (formData: FormData) => Promise<void>;
  statusOptions: { value: string; label: string }[];
  overrideStatus: (formData: FormData) => Promise<void>;
  deleteInvoice: () => Promise<void>;
  // The final release: pushes a fully-approved (qbo_ready) bill to QBO.
  syncToQbo?: () => Promise<void>;
  // Wipes a stuck qbo_sync_status/qbo_error without retrying — for a bill
  // that failed while qbo_ready and then moved on (e.g. sent back to
  // review), where the error is stale and there's nothing to retry.
  clearQboError?: () => Promise<void>;
  // Undoes a SUCCESSFUL sync in Flow's own records only — does not touch
  // the Bill already created in QuickBooks. For a bill that synced with
  // something wrong on it and needs to be pushed again after a fix.
  clearQboSync?: () => Promise<void>;
}

export interface BillInstructionsEntry {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface BillInstructionsData {
  entries: BillInstructionsEntry[];
  readOnly: boolean;
  saveInstructions: (formData: FormData) => Promise<void>;
  approve?: (formData: FormData) => Promise<void>;
}

// Ghost fields: invisible border at rest, a line appears on hover/focus.
// The point is to read like a finished invoice document, not a form full
// of boxes — every value here is still fully editable in place.
const ghostField =
  "w-full border-b border-transparent bg-transparent px-0 py-1 text-sm text-slate-800 hover:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-500";
const ghostLabel = "block text-[10px] font-semibold uppercase tracking-wide text-slate-400";
// minmax(0, Nfr) — not plain Nfr — so tracks can actually shrink below
// their content's min-content width; a plain fr track refuses to go
// narrower than the widest unbreakable content (e.g. a long project
// name), which is what was forcing the whole table into its own
// horizontally-scrolling box on anything narrower than ~780px (the Bill
// panel itself defaults to 480px). Cells rely on `truncate` + a `title`
// tooltip for anything that still doesn't fit.
//
// Class and Tax are short, fixed-shape values (a project code, a 1-2
// digit %) — as `fr` tracks they used to balloon with the panel's width
// and look mostly empty; Amount is a currency figure ("-165,000.00") that
// needs real room and was getting squeezed. Class/Tax are now small fixed
// widths instead of flexible shares, and that space moved to Amount.
//
// Description is free text (wraps rather than truncates) and the one
// people actually read — it was getting squeezed as badly as Category/
// Project once the panel narrows (e.g. splitting 50/50 with an open
// document), wrapping into a tall, cramped column. It now gets clearly
// the largest share of the three flexible columns.
//
// Class now carries the per-line CON/CO/E toggle (Contract vs Change
// Orders vs Extras) plus the full class search, so it needs real room:
// it's a fixed track (like Tax/Amount), widened from 76px to 118px to fit
// two toggle buttons, then to 176px for a third plus enough room for the
// search box to actually show "Change Orders" instead of truncating to
// "Chang…" once a value is committed and it goes idle.
// Leading 22px column: the per-line select checkbox (bulk delete/etc.).
const LINE_ITEM_COLS =
  "grid-cols-[22px_minmax(0,0.85fr)_minmax(0,1.5fr)_minmax(0,1.15fr)_176px_52px_104px_44px_42px]";

// The exact QBO class names the CON/CO/E toggle writes (must exist in the
// org's qbo_classes mirror — Fluid's QBO has "Contract", "Change Orders",
// and "Extras"). The construction fold app reads these per-line class
// names back out of QBO to separate contract value, change orders, and
// extras.
const CON_CLASS_NAME = "Contract";
const CO_CLASS_NAME = "Change Orders";
const EXTRAS_CLASS_NAME = "Extras";

// ApprovalMax-style "Bill" panel, styled as a document: every data item is
// editable in place and maps to QBO on sync (vendor/bill number/dates/
// amount/currency/tax on the bill, category-details rows as line items,
// accounting instructions as the memo). Pure presentational; collapse
// state lives in DetailSplit. Authored by Araza.
export function BillPanel({
  invoice,
  documentCount,
  lineItems,
  projects,
  qboCategories,
  qboSuppliers,
  qboClasses,
  qboTaxRates,
  qboTaxUsesCodes,
  orgDefaultTaxRate,
  orgDefaultTaxCodeId,
  qboSupplierDefaultTaxRates,
  saveBill,
  saveLineItem,
  deleteLineItem,
  cloneLineItem,
  reExtract,
  getPageCount,
  reorderPages,
  backToReview,
  canReview,
  readOnly,
  classReadOnly,
  canComment,
  supplierDefaults,
  saveSupplierDefaults,
  auditTimeline,
  comments,
  authorNameById,
  addComment,
  members,
  approval,
  admin,
  instructions,
  qboConnected,
  qboRealmId,
  qboVendorId,
  alerts,
  onOpenDocument,
  onCollapse,
  resetScrollKey,
}: {
  invoice: Invoice;
  documentCount: number;
  lineItems: LineItem[];
  projects: { id: string; name: string }[];
  // QBO mirrors (read-only) for dropdowns: bill categories (numbered),
  // suppliers, classes, and tax rates. Flow never writes these to QBO.
  qboCategories?: string[];
  qboSuppliers?: string[];
  qboClasses?: string[];
  // value = QBO tax code id (see resolveTaxCode in qbo.ts), secondaryValue
  // = its resolved rate. False qboTaxUsesCodes means these fell back to
  // plain rates instead (no tax codes synced) — value IS the rate then.
  qboTaxRates?: { value: string; label: string; secondaryValue?: string }[];
  qboTaxUsesCodes?: boolean;
  // Settings → the default tax rate/code for new invoices (organizations.
  // default_tax_rate/default_tax_code_id) — whatever the admin actually
  // picked there, never hardcoded here. Pre-fills a freshly-added line's
  // Tax field so it isn't blank by default.
  orgDefaultTaxRate?: number | null;
  orgDefaultTaxCodeId?: string | null;
  // Rate-only options for the vendor default-rules modal — supplier
  // defaults have no tax code identity to attach (see saveSupplierDefaults).
  qboSupplierDefaultTaxRates?: { value: string; label: string }[];
  saveBill: (formData: FormData) => Promise<void>;
  saveLineItem: (
    lineItemId: string,
    formData: FormData
  ) => Promise<void>;
  deleteLineItem: (lineItemId: string) => Promise<void>;
  cloneLineItem: (lineItemId: string) => Promise<void>;
  reExtract: () => Promise<void>;
  getPageCount: (invoiceId: string) => Promise<number | null>;
  reorderPages: (
    invoiceId: string,
    order: number[]
  ) => Promise<{ ok: boolean; error?: string }>;
  backToReview: () => Promise<void>;
  canReview: boolean;
  // Blanket lock: category/description/project/tax/amount, bill header
  // fields, add/delete/clone lines, re-extract, reorder pages. A plain
  // "user" member gets this true unconditionally — their only two editable
  // fields (class, the accounting note) are gated separately below/via
  // instructions.readOnly, since those stay open until THEY approve.
  readOnly: boolean;
  // Independent of readOnly — a plain user can toggle CON/CO/E right up
  // until they approve this invoice, even though everything else above is
  // already locked for them.
  classReadOnly: boolean;
  // Independent of readOnly — Discussion stays open for a plain user even
  // after everything else (including class/notes, post-approval) locks.
  canComment: boolean;
  supplierDefaults: SupplierDefaultsValues;
  saveSupplierDefaults: (formData: FormData) => Promise<void>;
  auditTimeline: AuditTimelineEntry[];
  comments: Comment[];
  authorNameById: Map<string, string>;
  addComment: (formData: FormData) => Promise<void>;
  members: { id: string; label: string }[];
  approval: BillApprovalData;
  admin: BillAdminData;
  instructions: BillInstructionsData;
  qboConnected: boolean;
  qboRealmId: string | null;
  qboVendorId: string | null;
  // Server-rendered banners (decision errors, possible-duplicate warnings)
  // slotted in above everything else.
  alerts?: ReactNode;
  onOpenDocument: () => void;
  onCollapse: () => void;
  // Changing invoice resets the panel scroll to the top (the scroller is
  // reused across navigations, so without this the next invoice opens
  // scrolled down). Pass the invoice id.
  resetScrollKey?: string;
}) {
  // Reset the panel scroll to the top whenever the invoice changes.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [resetScrollKey]);

  const { showToast } = useToast();
  // For floating confirmation toasts (Approve/Reject/Hold) — the invoice
  // can vanish from view the instant a decision moves it off this user's
  // plate, so toasts name what just happened rather than a bare status
  // word. Matches Dext/ApprovalMax's own floating confirmation.
  const invoiceLabel = `${invoice.vendor_name ?? invoice.file_name}${
    invoice.invoice_number ? ` #${invoice.invoice_number}` : ""
  }`;

  const fmt = (n: number | null) =>
    n != null
      ? n.toLocaleString(undefined, {
          style: "currency",
          currency: invoice.currency,
        })
      : "—";
  // Amount/tax edits as they happen, keyed by line item id — lets the
  // totals block below react the instant you type an amount or pick a tax
  // rate, instead of waiting for that field's own save + revalidate round
  // trip to land. Cleared whenever fresh server data arrives (that IS the
  // authoritative update landing, so any override is redundant by then).
  const [liveAmounts, setLiveAmounts] = useState<Record<string, number | null>>({});
  const [liveTaxRates, setLiveTaxRates] = useState<Record<string, number | null>>({});
  useEffect(() => {
    setLiveAmounts({});
    setLiveTaxRates({});
  }, [lineItems]);
  const effectiveLineItems = lineItems.map((li) => ({
    ...li,
    amount: li.id in liveAmounts ? liveAmounts[li.id] : li.amount,
    tax_rate: li.id in liveTaxRates ? liveTaxRates[li.id] : li.tax_rate,
  }));

  // Subtotal/tax/total are ALWAYS derived live from the line items shown
  // below (amount × each line's own tax rate%, blank rate = no tax) — this
  // is what's really entered right now, never silently swapped for the
  // document's own printed total. If it disagrees with the document total,
  // invoice.totals_note flags that as a warning below; the fix is
  // correcting the line items (a missing line, a wrong amount) until this
  // live total naturally matches the document, not a different number
  // being substituted here. Before any line items exist there's nothing to
  // derive from, so fall back to the invoice's own (extracted) figures.
  const hasLineItems = lineItems.length > 0;
  const derivedTotals = computeLineItemTotals(effectiveLineItems);
  const subtotal = hasLineItems ? derivedTotals.subtotal : invoice.amount;
  const tax = hasLineItems ? derivedTotals.tax : invoice.tax_amount;
  const amount = hasLineItems ? derivedTotals.total : invoice.amount;
  const num2 = (n: number | null) =>
    n != null
      ? n.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : "";

  // Bold "@Name" in a posted comment when it matches a real member name
  // (longest names first so "Ali Raza" wins over a hypothetical "Ali").
  const mentionNamePattern =
    members.length > 0
      ? new RegExp(
          `@(${[...members]
            .sort((a, b) => b.label.length - a.label.length)
            .map((m) => m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|")})`,
          "g"
        )
      : null;
  function renderCommentBody(body: string) {
    if (!mentionNamePattern) return body;
    const parts: (string | { key: number; name: string })[] = [];
    let lastIndex = 0;
    let key = 0;
    for (const match of body.matchAll(mentionNamePattern)) {
      const index = match.index ?? 0;
      if (index > lastIndex) parts.push(body.slice(lastIndex, index));
      parts.push({ key: key++, name: match[1] });
      lastIndex = index + match[0].length;
    }
    parts.push(body.slice(lastIndex));
    return parts.map((p) =>
      typeof p === "string" ? (
        p
      ) : (
        <span key={p.key} className="font-semibold text-blue-700">
          @{p.name}
        </span>
      )
    );
  }
  const vendor = invoice.vendor_name ?? invoice.file_name ?? "Unknown vendor";
  const billNumber = invoice.invoice_number ?? "—";
  // The vendor's own email, as OCR'd off the invoice document — not
  // source_email (which invoice.source_email actually is: the address
  // that emailed the invoice INTO Flow, e.g. an AP inbox or a forwarder,
  // not the vendor). vendor_email only ever lives inside the extraction
  // JSON; there's no dedicated column for it.
  const vendorEmail =
    typeof invoice.extraction?.vendor_email === "string"
      ? invoice.extraction.vendor_email
      : null;
  const billDateDefault = invoice.bill_date ?? invoice.created_at.slice(0, 10);

  // Bill fields save automatically when a field loses focus (no Save
  // button); Review Complete in the side panel then just routes. In
  // read-only (auditor) mode the fields are disabled instead.
  const billFormRef = useRef<HTMLFormElement>(null);
  const billBlur = readOnly
    ? { disabled: true as const }
    : { onBlur: () => billFormRef.current?.requestSubmit() };

  // The blank "add line" row only shows up when explicitly asked for
  // (the "+ Add line" button) instead of always sitting at the bottom of
  // the table — it used to be the ONLY way to add a line at all, which
  // meant a permanently-open, half-filled-looking row for every bill.
  // Once the save actually lands (a new id shows up in `lineItems`,
  // fed back in from the server after revalidation) the blank row
  // closes itself again rather than doubling up with the now-real row.
  const [addingLine, setAddingLine] = useState(false);
  const knownLineItemIds = useRef(new Set(lineItems.map((li) => li.id)));
  useEffect(() => {
    const ids = new Set(lineItems.map((li) => li.id));
    if (addingLine && lineItems.some((li) => !knownLineItemIds.current.has(li.id))) {
      setAddingLine(false);
    }
    knownLineItemIds.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineItems]);

  // Bulk select/delete across line items — separate from the invoice
  // list's own multi-select, this is about picking several lines WITHIN
  // one bill (e.g. clearing out a batch of stray $0 rows at once instead
  // of one at a time).
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    // A deleted/replaced line shouldn't linger in the selection.
    setSelectedLineIds((prev) => {
      const ids = new Set(lineItems.map((li) => li.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [lineItems]);
  // Staged Project/Class values for the bulk-apply bar below — picking a
  // value only stages it here; nothing is written until Save is pressed.
  // Reset whenever the selection itself changes, so a value staged for one
  // set of lines can never get applied to a different set picked afterward.
  // null = nothing staged yet (leave the line's own value alone); "" is a
  // real staged value meaning "clear it" — they must stay distinguishable,
  // or an intentional bulk-clear would be indistinguishable from "not
  // touched" and silently fall back to each line's existing value below.
  const [bulkCategoryDraft, setBulkCategoryDraft] = useState<string | null>(null);
  const [bulkProjectDraft, setBulkProjectDraft] = useState<string | null>(null);
  const [bulkClassDraft, setBulkClassDraft] = useState<string | null>(null);
  const [bulkKey, setBulkKey] = useState(0);
  const resetBulkDrafts = () => {
    setBulkCategoryDraft(null);
    setBulkProjectDraft(null);
    setBulkClassDraft(null);
    setBulkKey((k) => k + 1);
  };
  const allLinesSelected = lineItems.length > 0 && selectedLineIds.size === lineItems.length;
  const toggleLineSelected = (id: string) => {
    resetBulkDrafts();
    setSelectedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllLinesSelected = () => {
    resetBulkDrafts();
    setSelectedLineIds(allLinesSelected ? new Set() : new Set(lineItems.map((li) => li.id)));
  };
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const handleBulkDelete = async () => {
    const ids = [...selectedLineIds];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} selected line item${ids.length === 1 ? "" : "s"}? This can't be undone.`
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    try {
      await Promise.all(ids.map((id) => deleteLineItem(id)));
      setSelectedLineIds(new Set());
      resetBulkDrafts();
    } finally {
      setBulkDeleting(false);
    }
  };

  // Apply one Project and/or Class to every selected line in one action —
  // built for the common case of a bill where every line shares the same
  // project/class and re-picking it per line is pure repetition. Picking a
  // value only STAGES it (bulkProjectDraft/bulkClassDraft) — it does not
  // write anything until Save is pressed. Committing on every pick used to
  // fire a full round trip (and its revalidation) per field the instant it
  // was picked, which is what made the bar feel like it froze when you
  // moved on to the next field before that round trip settled; a single
  // explicit Save now covers both fields in one pass.
  const [bulkSetting, setBulkSetting] = useState(false);
  const handleBulkSave = async () => {
    const ids = [...selectedLineIds];
    if (
      ids.length === 0 ||
      (bulkCategoryDraft === null && bulkProjectDraft === null && bulkClassDraft === null)
    )
      return;
    setBulkSetting(true);
    try {
      await Promise.all(
        ids.map((id) => {
          const line = lineItems.find((li) => li.id === id);
          if (!line) return Promise.resolve();
          const formData = new FormData();
          formData.set("category", bulkCategoryDraft ?? line.category ?? "");
          formData.set("description", line.description ?? "");
          formData.set("tax_rate", line.tax_rate != null ? String(line.tax_rate) : "");
          formData.set("qbo_tax_code_id", line.qbo_tax_code_id ?? "");
          formData.set("class", bulkClassDraft ?? line.class ?? "");
          formData.set("project_id", bulkProjectDraft ?? line.project_id ?? "");
          formData.set("amount", line.amount != null ? String(line.amount) : "");
          if (line.linked) formData.set("linked", "on");
          return saveLineItem(id, formData);
        })
      );
      resetBulkDrafts();
    } finally {
      setBulkSetting(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col border-r border-slate-200 bg-white">
      <div className="flex flex-none items-center justify-between border-b border-slate-200 px-4 py-2">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">
          Bill
        </span>
        <button
          type="button"
          onClick={onCollapse}
          title="Hide bill"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        {alerts && <div className="space-y-3 px-6 pt-4">{alerts}</div>}

        {/* Admin toolbar (one line, admin-only, at the very top) + Instructions
            for accounting / Status & approval side by side below it — above
            the bill itself, since who has it and what to do about it is the
            most actionable thing here. */}
        <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
          {admin.visible && (
            <div className="mb-4 border-b border-slate-200 pb-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                Admin
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
                {admin.showReassign && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">Reassign to</span>
                    <InlineSelectSave
                      key={`reassign-${invoice.id}`}
                      name="approver_id"
                      defaultValue={admin.reassignDefaultValue}
                      options={[
                        { value: "", label: "— workflow default —" },
                        ...admin.memberOptions.map((m) => ({
                          value: m.id,
                          label: m.label,
                        })),
                      ]}
                      action={admin.reassign}
                    />
                  </div>
                )}
                {admin.stageOptions.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">Stage</span>
                    <InlineSelectSave
                      key={`stage-${invoice.id}`}
                      name="stage"
                      defaultValue={admin.stageDefaultValue}
                      options={admin.stageOptions}
                      action={admin.setStage}
                    />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Override status</span>
                  <InlineSelectSave
                    key={`override-status-${invoice.id}`}
                    name="status"
                    defaultValue={invoice.status}
                    options={admin.statusOptions}
                    action={admin.overrideStatus}
                  />
                </div>
                <ConfirmSubmitButton
                  action={admin.deleteInvoice}
                  confirmMessage={`Permanently delete this invoice${
                    invoice.vendor_name ? ` from ${invoice.vendor_name}` : ""
                  }? This removes it, its line items, documents, and discussion — it cannot be undone.`}
                  className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  Delete invoice
                </ConfirmSubmitButton>
              </div>
            </div>
          )}

          {/* Both columns are full-height flex columns whose action rows are
              pushed down with mt-auto, so Approve and Hold/Reject/Cancel sit
              on one baseline regardless of how the copy above them wraps. */}
          <div className="grid grid-cols-2 items-stretch gap-6">
            <div className="flex flex-col">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                Instructions for accounting
              </div>
              <div className="flex-1">
                <InstructionsBox
                  key={`instructions-${invoice.id}`}
                  entries={instructions.entries}
                  readOnly={instructions.readOnly}
                  saveInstructions={instructions.saveInstructions}
                  approve={instructions.approve}
                  invoiceLabel={invoiceLabel}
                />
              </div>
            </div>

            <div className="flex flex-col">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                Status &amp; approval
              </div>
              <div className="flex flex-1 flex-col">
                {approval.currentStepApproverNames.length > 0 && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-amber-100 text-amber-700">
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                        <path
                          d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-3.5 3.5-6 8-6s8 2.5 8 6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <p className="text-sm text-amber-900">
                      Currently with{" "}
                      <span className="font-bold">
                        {approval.currentStepApproverNames.join(", ")}
                      </span>
                    </p>
                  </div>
                )}
                {approval.steps.length > 0 && (
                  <div className="mt-3">
                    <ApprovalStepper
                      steps={approval.steps}
                      stepStates={approval.stepStates}
                      currentStepOrder={invoice.current_step_order}
                      invoiceStatus={invoice.status}
                    />
                  </div>
                )}
                {invoice.status !== "rejected" &&
                  invoice.status !== "cancelled" && (
                    <>
                      {/* Status copy sits in normal flow right under the
                          stepper; only the button row is pinned to the
                          bottom so it lines up with Approve. */}
                      {/* Text + link are for everyone — QBO sync is
                          general-interest info, not sensitive. qbo_bill_id
                          alone is enough to build the link: the URL takes
                          no realm id, and qboConnected/qboRealmId are only
                          ever non-null for admins anyway (qbo_connections
                          is RLS'd to admins — see where it's fetched in
                          page.tsx), which used to hide a perfectly valid
                          link from every non-admin viewer. Undo sync stays
                          admin-only, in the button row below. */}
                      {invoice.status === "approved" && (
                        <>
                          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-emerald-700">
                            <span className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-500" />
                            Synced to QuickBooks
                            {invoice.qbo_synced_at && (
                              <>
                                {" "}—{" "}
                                <LocalTime iso={invoice.qbo_synced_at} withYear />
                              </>
                            )}
                            {invoice.qbo_bill_id && (
                              <a
                                href={`https://qbo.intuit.com/app/bill?txnId=${invoice.qbo_bill_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium text-blue-600 hover:underline"
                              >
                                Open in QuickBooks Online ↗
                              </a>
                            )}
                          </p>
                          {invoice.qbo_error && (
                            <p className="mt-1 text-sm text-amber-700">
                              Bill created, but attachments failed:{" "}
                              {invoice.qbo_error}
                            </p>
                          )}
                        </>
                      )}
                      {/* Sync only ever touches qbo_sync_status/qbo_error,
                          never invoice.status — so an error here with the
                          bill no longer qbo_ready means it failed, then got
                          sent back to review (or otherwise moved on) before
                          anyone retried. Nothing to retry against anymore,
                          so this only offers Clear (a real Retry lives in
                          the qbo_ready branch below instead). Shown to
                          everyone same as above; only the Clear button
                          itself is admin-only. */}
                      {invoice.qbo_sync_status === "error" &&
                        invoice.status !== "qbo_ready" &&
                        invoice.status !== "approved" && (
                          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                            Sync failed
                            {invoice.qbo_error ? `: ${invoice.qbo_error}` : ""}
                          </p>
                        )}
                      {invoice.status === "on_review" && !canReview && (
                        <p className="mt-3 text-sm text-slate-500">
                          Awaiting review — an admin must complete the review
                          to send it into the approval workflow.
                        </p>
                      )}
                      {invoice.status === "on_hold" && (
                        <p className="mt-3 text-sm text-slate-500">
                          On hold — set aside for later. Click Unhold to
                          resume working on it.
                        </p>
                      )}
                      {/* qbo_ready means every approval step already
                          passed — current_step_order is just stale from
                          the last real step, so the generic "waiting on
                          an approver" / "no approver matches" copy below
                          (meant for an invoice still IN approval) is
                          wrong here. This is the actual next action, so
                          it gets the same prominent spot as Approve/Hold
                          rather than living only in the QuickBooks Online
                          section further down the panel. */}
                      {invoice.status === "qbo_ready" ? (
                        admin.visible ? (
                          invoice.qbo_sync_status === "error" ? (
                            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                              Sync failed
                              {invoice.qbo_error ? `: ${invoice.qbo_error}` : ""}
                            </p>
                          ) : (
                            <p className="mt-3 text-sm text-sky-700">
                              Workflow complete — this bill is ready for the
                              final QuickBooks release.
                            </p>
                          )
                        ) : (
                          <p className="mt-3 text-sm text-slate-500">
                            Waiting for an admin to release this bill to
                            QuickBooks.
                          </p>
                        )
                      ) : (
                        invoice.status !== "approved" &&
                        invoice.status !== "on_review" &&
                        invoice.status !== "on_hold" &&
                        !approval.canDecide &&
                        (approval.currentStepApproverNames.length > 0 ? (
                          <p className="mt-3 text-sm text-slate-500">
                            Waiting on the approver for step{" "}
                            {invoice.current_step_order}.
                          </p>
                        ) : (
                          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                            No approver currently matches this invoice at
                            step {invoice.current_step_order} — its
                            Class/Category/Supplier/Customer don&apos;t match
                            any configured approver, and there&apos;s no
                            default approver on this step to fall back to. It
                            can&apos;t be approved as-is.
                            {canReview
                              ? " Use Reassign to in the Admin panel, or fix the step's approvers/conditions in Workflows."
                              : " An admin needs to reassign it or fix the step's approvers in Workflows."}
                          </p>
                        ))
                      )}

                      {/* Every button is flex-1, so one or several, the row
                          always spans the full column width — matching the
                          Approve button opposite. Each carries a border
                          (transparent where there's no visible outline) so
                          they're all exactly the same height. */}
                      {((invoice.status === "on_review" && canReview) ||
                        approval.canDecide ||
                        approval.canUnhold ||
                        approval.canCancel ||
                        (invoice.status === "qbo_ready" && admin.visible) ||
                        (invoice.status === "approved" &&
                          admin.visible &&
                          !!admin.clearQboSync) ||
                        (invoice.qbo_sync_status === "error" &&
                          invoice.status !== "qbo_ready" &&
                          invoice.status !== "approved" &&
                          admin.visible &&
                          !!admin.clearQboError)) && (
                        <div className="mt-auto flex gap-2 pt-3">
                          {invoice.status === "on_review" && canReview && (
                            <form action={approval.reviewComplete} className="flex-1">
                              <SubmitButton className="w-full rounded-md border border-transparent bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700">
                                Review Complete
                              </SubmitButton>
                            </form>
                          )}
                          {approval.canUnhold && (
                            <form action={approval.unhold} className="flex-1">
                              <SubmitButton className="w-full rounded-md border border-transparent bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700">
                                Unhold
                              </SubmitButton>
                            </form>
                          )}
                          {approval.canDecide && (
                            <>
                              <form
                                action={async (formData) => {
                                  await approval.hold(formData);
                                  showToast(`${invoiceLabel} put on hold`);
                                }}
                                className="flex-1"
                              >
                                <SubmitButton className="w-full rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm font-semibold text-amber-800 hover:bg-amber-100">
                                  Hold
                                </SubmitButton>
                              </form>
                              <div className="flex-1">
                                <RejectReasonModal reject={approval.reject} invoiceLabel={invoiceLabel} />
                              </div>
                            </>
                          )}
                          {approval.canCancel && !approval.canUnhold && (
                            <form action={approval.cancel} className="flex-1">
                              <SubmitButton className="w-full rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-semibold text-slate-600 hover:bg-slate-50">
                                Cancel
                              </SubmitButton>
                            </form>
                          )}
                          {invoice.status === "qbo_ready" && admin.visible && (
                            <form action={admin.syncToQbo} className="flex-1">
                              <SubmitButton
                                disabled={!qboConnected}
                                className="w-full rounded-md border border-transparent bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                              >
                                {qboConnected
                                  ? invoice.qbo_sync_status === "error"
                                    ? "Retry sync to QuickBooks"
                                    : "Sync to QuickBooks (final)"
                                  : "Connect QuickBooks in Settings first"}
                              </SubmitButton>
                            </form>
                          )}
                          {invoice.status === "approved" &&
                            admin.visible &&
                            admin.clearQboSync && (
                              <form action={admin.clearQboSync} className="flex-1">
                                <SubmitButton
                                  title="Only clears Flow's own record — the Bill already in QuickBooks is untouched."
                                  className="w-full rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-semibold text-slate-600 hover:bg-slate-50"
                                >
                                  Undo sync (allow re-sync)
                                </SubmitButton>
                              </form>
                            )}
                          {invoice.qbo_sync_status === "error" &&
                            invoice.status !== "qbo_ready" &&
                            invoice.status !== "approved" &&
                            admin.visible &&
                            admin.clearQboError && (
                              <form action={admin.clearQboError} className="flex-1">
                                <SubmitButton className="w-full rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-semibold text-slate-600 hover:bg-slate-50">
                                  Clear error
                                </SubmitButton>
                              </form>
                            )}
                        </div>
                      )}
                    </>
                  )}
              </div>
            </div>
          </div>
        </div>

        {/* Document header: title + big total, like a real invoice */}
        <div className="border-b border-slate-200 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-slate-900">
                Bill {billNumber} from {vendor}
              </h2>
              {!readOnly && invoice.vendor_name && (
                <div className="mt-1.5">
                  <SupplierRulesModal
                    vendorName={invoice.vendor_name}
                    qboCategories={qboCategories}
                    qboClasses={qboClasses}
                    qboTaxRates={qboSupplierDefaultTaxRates}
                    initialValues={supplierDefaults}
                    saveAction={saveSupplierDefaults}
                  />
                </div>
              )}
            </div>
            <div className="flex-none text-right">
              <div className="text-2xl font-bold tabular-nums text-slate-900">
                {fmt(amount)}
              </div>
              <div className="text-xs font-medium text-slate-400">{invoice.currency}</div>
              <div className="mt-1.5">
                <InvoiceStatusBadge status={invoice.status} />
              </div>
            </div>
          </div>

          {["on_approval", "on_hold", "rejected"].includes(invoice.status) &&
            canReview &&
            !readOnly && (
              <form action={backToReview} className="mt-3">
                <SubmitButton className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                  Back to Review
                </SubmitButton>
              </form>
            )}
        </div>

        {/* Editable bill fields — maps to the QBO bill on sync */}
        <form id="bill-form" ref={billFormRef} action={saveBill} className="hidden" />
        <div className="border-b border-slate-200 px-6 py-4">
          <div className="grid grid-cols-4 gap-x-6 gap-y-3">
            <label>
              <span className={ghostLabel}>Bill date</span>
              <input
                key={`bill-date-${invoice.id}`}
                form="bill-form"
                type="date"
                name="bill_date"
                defaultValue={billDateDefault}
                className={ghostField}
                {...billBlur}
              />
            </label>
            <label>
              <span className={ghostLabel}>Due date</span>
              <input
                key={`due-date-${invoice.id}`}
                form="bill-form"
                type="date"
                name="due_date"
                defaultValue={invoice.due_date ?? ""}
                className={ghostField}
                {...billBlur}
              />
            </label>
            <label>
              <span className={ghostLabel}>Bill number</span>
              <input
                key={`bill-number-${invoice.id}`}
                form="bill-form"
                name="bill_number"
                defaultValue={invoice.invoice_number ?? ""}
                className={ghostField}
                {...billBlur}
              />
            </label>
            <div>
              <span className={ghostLabel}>Documents</span>
              <div className={`${ghostField} text-slate-400`}>{documentCount} attached</div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-x-6 gap-y-3">
            <label className="col-span-2">
              <span className={ghostLabel}>Vendor name</span>
              <Combobox
                key={`vendor-name-${invoice.id}`}
                name="vendor_name"
                formId="bill-form"
                options={qboSuppliers ?? []}
                defaultValue={invoice.vendor_name ?? ""}
                placeholder={invoice.vendor_name ? undefined : "Type to search supplier…"}
                className={`${ghostField} font-medium`}
                disabled={readOnly}
                onCommit={() => billFormRef.current?.requestSubmit()}
              />
              {invoice.qbo_vendor_matched === false && (
                <span className="block text-[10px] font-medium text-red-600">
                  ⚠ Vendor not matched to a QuickBooks supplier — pick the
                  correct one above before this bill can sync.
                </span>
              )}
              {qboConnected && qboVendorId && (
                <a
                  href={`https://qbo.intuit.com/app/vendordetail?nameId=${qboVendorId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 block text-[11px] font-medium text-blue-600 hover:underline"
                >
                  Open vendor in QuickBooks Online ↗
                </a>
              )}
            </label>
            <label>
              <span className={ghostLabel}>Email</span>
              <input
                key={`source-email-${invoice.id}`}
                form="bill-form"
                name="source_email"
                defaultValue={vendorEmail ?? invoice.source_email ?? ""}
                className={ghostField}
                {...billBlur}
              />
              {(vendorEmail ?? invoice.source_email) && (
                <a
                  href={`mailto:${vendorEmail ?? invoice.source_email}`}
                  className="mt-0.5 block text-[11px] font-medium text-blue-600 hover:underline"
                >
                  ✉ Email vendor
                </a>
              )}
            </label>
            {/* Only meaningful once the bill has actually been pushed to
                QBO — kept current by the nightly cron
                (/api/cron/qbo-payment-sync) and the "Sync payment status"
                button, both sharing runQboPaymentSync in qbo.ts. There's
                no "paid date" on the bill itself in QuickBooks — it comes
                from a separately-synced BillPayment record, which is why
                this can lag a real-world payment until the next sync. */}
            {invoice.qbo_sync_status === "synced" && (
              <div>
                <span className={ghostLabel}>Payment status</span>
                <div className={`${ghostField} flex flex-wrap items-center gap-1.5`}>
                  {invoice.qbo_payment_status === "paid" ? (
                    <>
                      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
                        Paid
                      </span>
                      {invoice.qbo_paid_at && (
                        <span className="text-xs text-slate-500">
                          <LocalTime iso={invoice.qbo_paid_at} withYear />
                        </span>
                      )}
                    </>
                  ) : invoice.qbo_payment_status === "unpaid" ? (
                    <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800">
                      Unpaid
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">Not checked yet</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Category details — editable line items, table-style. Project is
            per-line (a bill can split across several projects) rather than
            a single invoice-level field, so it lives here, not above. */}
        <div className="border-b border-slate-200 px-6 py-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Category details
          </div>
          {!readOnly && selectedLineIds.size > 0 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-blue-50 px-3 py-1.5 text-xs text-blue-800">
              <span className="flex-none">
                {selectedLineIds.size} line{selectedLineIds.size === 1 ? "" : "s"} selected
              </span>
              <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                {qboCategories && qboCategories.length > 0 && (
                  <div className="w-60">
                    <Combobox
                      key={`bulk-category-${bulkKey}`}
                      name="_bulk_category"
                      formId="_bulk_line_actions"
                      options={qboCategories}
                      defaultValue=""
                      placeholder="Set category…"
                      className="w-full rounded-md border border-blue-200 bg-white px-2 py-1 text-xs"
                      disabled={bulkSetting}
                      onCommit={(value) => setBulkCategoryDraft(value)}
                    />
                  </div>
                )}
                {!classReadOnly && (
                  <div className="w-60">
                    <Combobox
                      key={`bulk-project-${bulkKey}`}
                      name="_bulk_project"
                      formId="_bulk_line_actions"
                      options={projects.map((p) => ({ label: p.name, value: p.id }))}
                      defaultValue=""
                      placeholder="Set project…"
                      className="w-full rounded-md border border-blue-200 bg-white px-2 py-1 text-xs"
                      disabled={bulkSetting}
                      onCommit={(value) => setBulkProjectDraft(value)}
                    />
                  </div>
                )}
                {!classReadOnly && qboClasses && qboClasses.length > 0 && (
                  <div className="w-44">
                    <Combobox
                      key={`bulk-class-${bulkKey}`}
                      name="_bulk_class"
                      formId="_bulk_line_actions"
                      options={qboClasses}
                      defaultValue=""
                      placeholder="Set class…"
                      className="w-full rounded-md border border-blue-200 bg-white px-2 py-1 text-xs"
                      disabled={bulkSetting}
                      onCommit={(value) => setBulkClassDraft(value)}
                    />
                  </div>
                )}
                {(bulkCategoryDraft !== null ||
                  bulkProjectDraft !== null ||
                  bulkClassDraft !== null) && (
                  <button
                    type="button"
                    disabled={bulkSetting}
                    onClick={handleBulkSave}
                    className="rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {bulkSetting ? "Saving…" : "Save"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedLineIds(new Set());
                    resetBulkDrafts();
                  }}
                  className="font-medium text-blue-700 hover:underline"
                >
                  Clear
                </button>
                <button
                  type="button"
                  disabled={bulkDeleting}
                  onClick={handleBulkDelete}
                  className="font-medium text-red-600 hover:underline disabled:opacity-50"
                >
                  {bulkDeleting ? "Deleting…" : "Delete selected"}
                </button>
              </div>
            </div>
          )}
          <div className="mt-2">
            <div
              className={`grid ${LINE_ITEM_COLS} items-end gap-x-2 border-b border-slate-200 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400`}
            >
              {readOnly ? (
                <span />
              ) : (
                <input
                  type="checkbox"
                  title="Select all lines"
                  checked={allLinesSelected}
                  onChange={toggleAllLinesSelected}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
              )}
              <span>Category</span>
              <span>Description</span>
              <span>Project / customer</span>
              <span>Class</span>
              <span className="text-right">Tax %</span>
              <span className="text-right">Amount</span>
              <span className="text-center">Linked</span>
              <span />
            </div>
            {lineItems.map((item) => (
              <LineItemRow
                key={item.id}
                itemId={item.id}
                defaults={{
                  category: item.category ?? "",
                  description: item.description ?? "",
                  tax_rate: item.tax_rate ?? "",
                  qbo_tax_code_id: item.qbo_tax_code_id ?? "",
                  class: item.class ?? "",
                  project_id: item.project_id ?? "",
                  amount: num2(item.amount),
                  linked: item.linked,
                }}
                projects={projects}
                qboCategories={qboCategories}
                qboClasses={qboClasses}
                qboTaxRates={qboTaxRates}
                qboTaxUsesCodes={qboTaxUsesCodes}
                saveLineItem={saveLineItem}
                deleteLineItem={deleteLineItem}
                cloneLineItem={cloneLineItem}
                readOnly={readOnly}
                classReadOnly={classReadOnly}
                selected={selectedLineIds.has(item.id)}
                onToggleSelected={() => toggleLineSelected(item.id)}
                onAmountChange={(v) =>
                  setLiveAmounts((prev) => ({ ...prev, [item.id]: v }))
                }
                onTaxRateChange={(v) =>
                  setLiveTaxRates((prev) => ({ ...prev, [item.id]: v }))
                }
              />
            ))}
            {!readOnly && addingLine && (
              <LineItemRow
                itemId="new"
                defaults={{
                  category: "",
                  description: "",
                  // Pre-filled from Settings' default tax rate/code (see
                  // orgDefaultTaxRate/orgDefaultTaxCodeId), not hardcoded —
                  // whatever an admin actually picked there.
                  tax_rate: orgDefaultTaxRate ?? "",
                  qbo_tax_code_id: orgDefaultTaxCodeId ?? "",
                  class: "",
                  project_id: "",
                  amount: "",
                  linked: false,
                }}
                projects={projects}
                qboCategories={qboCategories}
                qboClasses={qboClasses}
                qboTaxRates={qboTaxRates}
                qboTaxUsesCodes={qboTaxUsesCodes}
                saveLineItem={saveLineItem}
                deleteLineItem={undefined}
                cloneLineItem={undefined}
                readOnly={false}
                classReadOnly={false}
                onCancel={() => setAddingLine(false)}
              />
            )}
          </div>
          {!readOnly && !addingLine && (
            <button
              type="button"
              onClick={() => setAddingLine(true)}
              className="mt-2 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              + Add line
            </button>
          )}

          {/* Totals — derived from the line items above (Amount × each
              line's Tax %); not separately editable. currency still
              submits through bill-form so autosaving other fields on
              this form doesn't reset it. */}
          <div className="mt-4 flex justify-end">
            <div className="w-56 space-y-1.5">
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>Subtotal</span>
                <span className="tabular-nums">{num2(subtotal)}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>Tax</span>
                <span className="tabular-nums">{num2(tax)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 text-base font-semibold text-slate-900">
                <span>Total</span>
                <span className="tabular-nums">{num2(amount)}</span>
                <input
                  form="bill-form"
                  type="hidden"
                  name="currency"
                  value={invoice.currency}
                  readOnly
                />
              </div>
              {invoice.totals_note && (
                <p className="pt-2 text-xs text-amber-700">{invoice.totals_note}</p>
              )}
            </div>
          </div>
        </div>

        {/* Links */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3 text-xs">
          <button
            type="button"
            onClick={onOpenDocument}
            className="font-medium text-blue-600 hover:underline"
          >
            Open the original document
          </button>
          {!readOnly && (
            <form action={reExtract}>
              <SubmitButton className="font-medium text-blue-600 hover:text-blue-700 hover:underline">
                Re-extract document fields
              </SubmitButton>
            </form>
          )}
          {!readOnly &&
            invoice.file_name?.toLowerCase().endsWith(".pdf") && (
              <ReorderPagesModal
                invoiceId={invoice.id}
                getPageCount={getPageCount}
                reorder={reorderPages}
              />
            )}
        </div>

        <div className="border-t border-slate-100 px-6 py-3">
          <CollapsibleSection
            title="Discussion / Notes"
            badge={comments.length > 0 ? comments.length : undefined}
          >
            <div className="mt-3 space-y-3">
              {comments.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No comments yet. Chat with your team about this invoice here.
                </p>
              ) : (
                comments.map((comment) => (
                  <div key={comment.id} className="rounded-md bg-slate-50 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-slate-700">
                        {comment.author_id
                          ? authorNameById.get(comment.author_id) ?? "Team member"
                          : "System"}
                      </span>
                      <LocalTime
                        iso={comment.created_at}
                        className="text-xs text-slate-400"
                      />
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                      {renderCommentBody(comment.body)}
                    </p>
                  </div>
                ))
              )}
            </div>
            {canComment && (
              <form action={addComment} className="mt-3 flex gap-2">
                <MentionComposer
                  members={members}
                  placeholder="Ask a question or leave a note… (@ to mention someone)"
                />
                <SubmitButton className="rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
                  Post
                </SubmitButton>
              </form>
            )}
          </CollapsibleSection>
        </div>

        <div className="border-t border-slate-100 px-6 py-3">
          <CollapsibleSection
            title="Audit trail"
            badge={auditTimeline.length}
            defaultOpen={false}
          >
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-xs text-slate-400">
                Everything that happened on this invoice, in order.
              </p>
              <a
                href={`/api/invoices/${invoice.id}/audit-trail`}
                className="flex-none text-xs font-medium text-blue-600 hover:underline"
              >
                Download Audit Report
              </a>
            </div>
            {auditTimeline.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No activity recorded yet.</p>
            ) : (
              <ol className="mt-3 space-y-3">
                {auditTimeline.map((entry) => {
                  const summaryText = entry.kind === "comment" ? "commented" : entry.summary;
                  // Reject/approve need to stand out scanning the trail —
                  // bold + colored on whichever line actually mentions it
                  // (the summary line for the decision itself, the detail
                  // line for a reject-reason comment), not the whole entry.
                  // \bapproved\b (not a bare /approve/) so "Reassigned to a
                  // different approver" doesn't false-positive as green.
                  const summaryIsReject = /reject/i.test(summaryText);
                  const summaryIsApproved = /\bapproved\b/i.test(summaryText);
                  const detailIsReject = entry.detail ? /reject/i.test(entry.detail) : false;
                  const detailIsApproved = entry.detail
                    ? /\bapproved\b/i.test(entry.detail)
                    : false;
                  const summaryColorCls = summaryIsReject
                    ? "font-bold text-red-600"
                    : summaryIsApproved
                      ? "font-bold text-emerald-600"
                      : "text-slate-700";
                  const detailColorCls = detailIsReject
                    ? "font-bold text-red-600"
                    : detailIsApproved
                      ? "font-bold text-emerald-600"
                      : "text-slate-500";
                  return (
                    <li key={entry.id} className="border-l-2 border-slate-200 pl-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className={`text-sm ${summaryColorCls}`}>
                          <span className={summaryIsReject || summaryIsApproved ? "" : "font-medium"}>
                            {entry.actorName}
                          </span>{" "}
                          {summaryText}
                        </p>
                        <LocalTime
                          iso={entry.at}
                          className="flex-none text-[11px] text-slate-400"
                        />
                      </div>
                      {entry.detail && (
                        <p className={`mt-0.5 text-xs ${detailColorCls}`}>{entry.detail}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}

function LineItemRow({
  itemId,
  defaults,
  projects,
  qboCategories,
  qboClasses,
  qboTaxRates,
  qboTaxUsesCodes,
  saveLineItem,
  deleteLineItem,
  cloneLineItem,
  readOnly,
  classReadOnly,
  onCancel,
  selected,
  onToggleSelected,
  onAmountChange,
  onTaxRateChange,
}: {
  itemId: string;
  defaults: {
    category: string;
    description: string;
    tax_rate: number | "";
    qbo_tax_code_id: string;
    class: string;
    project_id: string;
    amount: string;
    linked: boolean;
  };
  projects: { id: string; name: string }[];
  qboCategories?: string[];
  qboClasses?: string[];
  qboTaxRates?: { value: string; label: string; secondaryValue?: string }[];
  qboTaxUsesCodes?: boolean;
  saveLineItem: (
    lineItemId: string,
    formData: FormData
  ) => Promise<void>;
  deleteLineItem?: (lineItemId: string) => Promise<void>;
  cloneLineItem?: (lineItemId: string) => Promise<void>;
  readOnly: boolean;
  // Independent of readOnly — see BillPanel's own classReadOnly for why.
  classReadOnly: boolean;
  // The blank add-line row's "cancel" button — dismisses it without
  // saving. Only meaningful when itemId === "new".
  onCancel?: () => void;
  // Bulk select (undefined for the "new" row — nothing to bulk-act on
  // before it's actually saved).
  selected?: boolean;
  onToggleSelected?: () => void;
  // Live totals: called with the field's current numeric value on every
  // change (Amount) or commit (Tax) — well before the autosave round trip
  // completes — so the Subtotal/Tax/Total block below reacts instantly
  // instead of waiting on a server round trip.
  onAmountChange?: (value: number | null) => void;
  onTaxRateChange?: (value: number | null) => void;
}) {
  const isNew = itemId === "new";
  const formId = `line-item-${itemId}`;
  const formRef = useRef<HTMLFormElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // The "Add" button below is associated with the hidden form via the
  // form="..." attribute, not by being a descendant of it — useFormStatus
  // only tracks descendants of the <form> it's actually inside, so it
  // can't see this submission. Tracked by hand instead.
  const [addPending, setAddPending] = useState(false);
  // The per-line class: one value shared by the CON/CO toggle buttons and
  // the class search box, carried into the hidden form by a dedicated
  // hidden input (the search box submits under a different name so the
  // two controls never fight over the same field). Synced back when the
  // server-confirmed value changes (e.g. a re-extract, or another user's
  // edit landing via revalidation).
  const [classValue, setClassValue] = useState(defaults.class);
  const classHiddenRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setClassValue(defaults.class);
  }, [defaults.class]);
  // Set the line's class and autosave (existing rows) / stage it (the new
  // row's Add button submits the hidden form anyway). The hidden input's
  // DOM value is written SYNCHRONOUSLY, exactly like the Combobox's own
  // commit logic — the form submits right after this call, before React
  // has re-rendered, so the DOM field must already hold the new value or
  // the old class gets saved.
  const commitClass = (value: string) => {
    if (classReadOnly) return;
    setClassValue(value);
    if (classHiddenRef.current) classHiddenRef.current.value = value;
    if (!isNew) formRef.current?.requestSubmit();
  };
  // group-hover/cell (not plain hover:) — these sit inside a per-field
  // wrapper (below) that spans the FULL row height, so hovering anywhere
  // in the column reveals the line, not just the thin sliver right around
  // the input itself once it's bottom-anchored in a tall row.
  const cellCls = "w-full truncate border-b border-transparent bg-transparent px-0 py-1.5 text-xs text-slate-800 group-hover/cell:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-400";
  // Description wraps and grows instead of truncating — PMs need to read
  // the whole thing, not just what fits on one line.
  // self-end: every other cell sits at the bottom of the row via its own
  // h-full/items-end wrapper (see cellWrapCls, fillCell); Description had
  // no such wrapper (its own height is already JS-driven — see
  // autoResizeDesc below) and defaulted to the top, out of step with
  // everything else whenever some OTHER cell (e.g. a wrapped Category
  // value) ends up taller and drives the row's height.
  const descCls = "w-full self-end resize-none overflow-hidden whitespace-pre-wrap break-words border-b border-transparent bg-transparent px-0 py-1.5 text-xs text-slate-800 hover:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-400";
  // Wraps the plain Amount <input> the same way Combobox's own fillCell
  // prop wraps Category/Project/Class/Tax: a nested single-cell grid so
  // the field (justify-items stretch, the default) still spans the full
  // column width, but only takes its own natural height and sits at the
  // bottom (align-items: end) of the wrapper — which itself spans the
  // full, row-defining height via the outer row's own default stretch.
  // "group/cell" scopes the hover so it doesn't clash with the row's own
  // (unnamed) group, used below for the per-row action icons.
  const cellWrapCls = "group/cell grid h-full items-end";
  const amountRef = useRef<HTMLInputElement>(null);

  const autoResizeDesc = useCallback(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  // Resize after the grid layout settles (requestAnimationFrame) AND
  // whenever the description changes (extraction, save, edits) — the mount-
  // only resize left long pre-filled descriptions clipped by overflow-hidden.
  useEffect(() => {
    const raf = requestAnimationFrame(autoResizeDesc);
    return () => cancelAnimationFrame(raf);
  }, [defaults.description, autoResizeDesc]);
  // The height set above is frozen in pixels — it only reflects how many
  // lines the text wrapped into at THAT width. Nothing re-ran it when the
  // column got narrower for a reason that has nothing to do with the text
  // itself (opening the document for the 50/50 split, dragging the bill
  // panel's own resize handle, collapsing the sidebar, resizing the
  // window): the same text now wraps into more lines, but the frozen
  // height doesn't grow, so the extra lines get clipped by
  // overflow-hidden. A ResizeObserver on the row reacts to a width change
  // for ANY reason, not just the ones some effect happened to be watching.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => autoResizeDesc());
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoResizeDesc]);

  // Existing rows save automatically when a field loses focus (no Save
  // button). The blank "add line" row keeps an explicit button. In
  // read-only (auditor) mode the fields are disabled.
  const blurSave = isNew
    ? {}
    : readOnly
      ? { disabled: true as const }
      : { onBlur: () => formRef.current?.requestSubmit() };
  const checkboxSave = isNew
    ? {}
    : readOnly
      ? { disabled: true as const }
      : { onChange: () => formRef.current?.requestSubmit() };

  return (
    <div
      ref={rowRef}
      className={`group grid ${LINE_ITEM_COLS} gap-x-2 border-b border-slate-100 py-0.5`}
    >
      <form
        id={formId}
        ref={formRef}
        action={saveLineItem.bind(null, itemId)}
        className="hidden"
      />
      <div className="flex h-full items-end pb-1.5">
        {!isNew && !readOnly && (
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={onToggleSelected}
            className="h-3.5 w-3.5 rounded border-slate-300"
          />
        )}
      </div>
      <Combobox
        formId={formId}
        name="category"
        options={qboCategories ?? []}
        defaultValue={defaults.category}
        placeholder={isNew ? "Search category…" : undefined}
        className={cellCls}
        disabled={readOnly}
        wrapWhenIdle
        fillCell
        onCommit={() => {
          if (!isNew && !readOnly) formRef.current?.requestSubmit();
        }}
      />
      <textarea
        ref={descRef}
        form={formId}
        name="description"
        rows={1}
        defaultValue={defaults.description}
        placeholder={isNew ? "Description" : undefined}
        className={descCls}
        onInput={autoResizeDesc}
        {...blurSave}
      />
      <Combobox
        formId={formId}
        name="project_id"
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        defaultValue={defaults.project_id ?? ""}
        placeholder={isNew ? "Search project…" : undefined}
        className={cellCls}
        disabled={readOnly}
        wrapWhenIdle
        fillCell
        onCommit={() => {
          if (!isNew && !readOnly) formRef.current?.requestSubmit();
        }}
      />
      {/* Class: the CON/CO/E toggle writes the three real QBO classes the
          construction fold app reads back ("Contract" / "Change Orders" /
          "Extras"); the search box handles every other class. The value
          lives in one hidden form field so the toggle, the search box, and
          the server all agree on a single `class` per line. */}
      <div className="flex h-full items-end gap-1 pb-1.5">
        <button
          type="button"
          disabled={classReadOnly}
          title="Contract — original contract value (CON). Click again to clear."
          onClick={() =>
            commitClass(classValue === CON_CLASS_NAME ? "" : CON_CLASS_NAME)
          }
          className={`flex-none rounded border px-1.5 py-1.5 text-[10px] font-semibold leading-4 transition-colors ${
            classValue === CON_CLASS_NAME
              ? "border-yellow-400 bg-yellow-400 text-slate-900"
              : "border-blue-500 text-blue-600 hover:bg-blue-50"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          CON
        </button>
        <button
          type="button"
          disabled={classReadOnly}
          title="Change Order — extra work beyond contract (CO). Click again to clear."
          onClick={() =>
            commitClass(classValue === CO_CLASS_NAME ? "" : CO_CLASS_NAME)
          }
          className={`flex-none rounded border px-1.5 py-1.5 text-[10px] font-semibold leading-4 transition-colors ${
            classValue === CO_CLASS_NAME
              ? "border-yellow-400 bg-yellow-400 text-slate-900"
              : "border-blue-500 text-blue-600 hover:bg-blue-50"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          CO
        </button>
        <button
          type="button"
          disabled={classReadOnly}
          title="Extras — work outside the contract and change orders (E). Click again to clear."
          onClick={() =>
            commitClass(classValue === EXTRAS_CLASS_NAME ? "" : EXTRAS_CLASS_NAME)
          }
          className={`flex-none rounded border px-1.5 py-1.5 text-[10px] font-semibold leading-4 transition-colors ${
            classValue === EXTRAS_CLASS_NAME
              ? "border-yellow-400 bg-yellow-400 text-slate-900"
              : "border-blue-500 text-blue-600 hover:bg-blue-50"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          E
        </button>
        {/* self-stretch overrides the row's own items-end for just this
            child, so it actually fills the row's full height — fillCell
            then bottom-anchors the real field within THAT, giving Class
            the same full-height hover/click target Category/Project/Tax
            already have (fillCell supplies its own group/cell wrapper, so
            none is needed here). */}
        <div className="min-w-0 flex-1 self-stretch">
          <Combobox
            formId={formId}
            name="class_search"
            options={qboClasses ?? []}
            defaultValue={defaults.class}
            placeholder={isNew ? "Search class…" : undefined}
            className={cellCls}
            disabled={classReadOnly}
            fillCell
            onCommit={commitClass}
          />
        </div>
        <input
          ref={classHiddenRef}
          type="hidden"
          form={formId}
          name="class"
          value={classValue}
          readOnly
        />
      </div>
      <Combobox
        formId={formId}
        name={qboTaxUsesCodes ? "qbo_tax_code_id" : "tax_rate"}
        secondaryName={qboTaxUsesCodes ? "tax_rate" : undefined}
        options={qboTaxRates ?? []}
        defaultValue={
          qboTaxUsesCodes
            ? defaults.qbo_tax_code_id
            : defaults.tax_rate === ""
              ? ""
              : String(defaults.tax_rate)
        }
        placeholder={isNew ? "Tax %" : undefined}
        className={`${cellCls} text-right tabular-nums`}
        disabled={readOnly}
        showValue
        minQueryLength={1}
        fillCell
        onCommit={(value) => {
          if (!isNew && !readOnly) formRef.current?.requestSubmit();
          // The submitted `value` is the QBO tax CODE id when this org uses
          // codes, not the rate — look the rate up from the same options
          // list (secondaryValue) so the live total math always has a
          // plain percentage to work with, regardless of which form this
          // field actually submits.
          const rateStr = qboTaxUsesCodes
            ? qboTaxRates?.find((o) => o.value === value)?.secondaryValue
            : value;
          const rate = Number(rateStr);
          onTaxRateChange?.(rateStr && Number.isFinite(rate) ? rate : null);
        }}
      />
      <div
        className={cellWrapCls}
        onClick={(e) => {
          if (readOnly || e.target !== e.currentTarget) return;
          amountRef.current?.focus();
        }}
      >
        <input
          ref={amountRef}
          form={formId}
          name="amount"
          type="text"
          inputMode="decimal"
          defaultValue={defaults.amount}
          className={`${cellCls} text-right tabular-nums`}
          disabled={readOnly}
          onChange={(e) => {
            // Live total preview only — a plain number, ignoring an
            // in-progress "=..." formula (nothing to compute yet until
            // it's committed on blur below).
            if (!isNew) {
              const raw = e.target.value.replace(/,/g, "").trim();
              const n = Number(raw);
              onAmountChange?.(raw && Number.isFinite(n) ? n : null);
            }
          }}
          onBlur={() => {
            const el = amountRef.current;
            if (readOnly || !el) return;
            // Evaluate as a formula regardless of isNew — clicking the
            // blank row's own "Add" button blurs this field first (a
            // button click's mousedown moves focus before its onClick
            // fires), so a typed formula is already resolved to a plain
            // number by the time Add reads the form.
            const raw = el.value.trim();
            if (raw) {
              const plain = Number(raw.replace(/,/g, ""));
              let finalValue: number;
              if (Number.isFinite(plain)) {
                finalValue = plain;
              } else {
                // A leading "=" is accepted but not required (QBO-style:
                // just type "10+10") — only reached once a PLAIN number
                // parse has already failed, so an ordinary amount like
                // "-165,000.00" never gets misread as an expression.
                const expr = raw.startsWith("=") ? raw.slice(1) : raw;
                const result = evaluateFormula(expr);
                if (result == null) {
                  // Not a valid number or a valid expression — leave the
                  // text as-is (so the mistake is visible) and don't
                  // submit it; saving it would either fail numeric
                  // validation downstream or, worse, be silently coerced
                  // to something the user never typed.
                  return;
                }
                finalValue = result;
              }
              // Reformat immediately (comma thousands + 2 decimals, same
              // as num2's display elsewhere) instead of waiting for the
              // save + revalidate round trip to bring back the
              // server-formatted value.
              el.value = finalValue.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
              if (!isNew) onAmountChange?.(finalValue);
            }
            if (!isNew) formRef.current?.requestSubmit();
          }}
        />
      </div>
      <div className="flex h-full items-end justify-center pb-1.5">
        <input
          form={formId}
          name="linked"
          type="checkbox"
          defaultChecked={defaults.linked}
          className="h-3.5 w-3.5 rounded border-slate-300"
          {...checkboxSave}
        />
        {/* A disabled checkbox and an enabled-but-unchecked one both submit
            nothing under "linked" — indistinguishable to saveLineItem via
            formData alone. This always-submitted marker tells it whether
            the checkbox was actually editable this time, so a class-only
            save (readOnly here, classReadOnly false) doesn't silently
            uncheck it. See the matching check in saveLineItem. */}
        <input type="hidden" form={formId} name="linked_editable" value={readOnly ? "" : "1"} />
      </div>
      {isNew ? (
        !readOnly && (
          <div className="flex h-full items-end justify-end gap-1.5 pb-1.5">
            <button
              type="button"
              title="Add line"
              disabled={addPending}
              onClick={async () => {
                if (!formRef.current) return;
                setAddPending(true);
                try {
                  await saveLineItem(itemId, new FormData(formRef.current));
                } finally {
                  setAddPending(false);
                }
              }}
              className={`text-sm font-medium text-blue-600 hover:underline ${addPending ? "opacity-60" : ""}`}
            >
              {addPending ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              title="Cancel"
              onClick={onCancel}
              className="text-slate-400 hover:text-slate-600"
            >
              ×
            </button>
          </div>
        )
      ) : (
        !readOnly && (
          <div className="flex h-full items-end justify-end gap-1.5 pb-1.5 opacity-0 group-hover:opacity-100">
            {cloneLineItem && (
              <form action={cloneLineItem.bind(null, itemId)}>
                <SubmitButton title="Clone line" className="text-slate-400 hover:text-blue-600">
                  ⧉
                </SubmitButton>
              </form>
            )}
            {deleteLineItem && (
              <form action={deleteLineItem.bind(null, itemId)}>
                <SubmitButton title="Delete line" className="text-slate-400 hover:text-red-500">
                  ×
                </SubmitButton>
              </form>
            )}
          </div>
        )
      )}
    </div>
  );
}
