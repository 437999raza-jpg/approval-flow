import { useEffect, useRef, useState, type ReactNode } from "react";
import { SupplierRulesModal, type SupplierDefaultsValues } from "./SupplierRulesModal";
import { Combobox } from "./Combobox";
import { CollapsibleSection } from "./CollapsibleSection";
import { MentionComposer } from "./MentionComposer";
import { ApprovalStepper } from "./ApprovalStepper";
import { InlineSelectSave } from "./InlineSelectSave";
import { ConfirmSubmitButton } from "./ConfirmSubmitButton";
import { SubmitButton } from "./SubmitButton";
import { InstructionsBox } from "./InstructionsBox";
import { ReorderPagesModal } from "./ReorderPagesModal";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import type { Database } from "@/lib/supabase/types";
import { computeLineItemTotals } from "@/lib/invoice-totals";
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
const LINE_ITEM_COLS =
  "grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,1.3fr)_88px_52px_104px_44px_42px]";

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
  readOnly: boolean;
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

  const fmt = (n: number | null) =>
    n != null
      ? n.toLocaleString(undefined, {
          style: "currency",
          currency: invoice.currency,
        })
      : "—";
  // Subtotal/tax/total are derived live from the line items shown below
  // (amount × each line's own tax rate%, blank rate = no tax) so the
  // totals block always matches what's actually in the table — not a
  // separately-typed figure that can drift out of sync. Before any line
  // items exist there's nothing to derive from, so fall back to the
  // invoice's own (extracted) figures.
  const hasLineItems = lineItems.length > 0;
  const derivedTotals = computeLineItemTotals(lineItems);
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
                  hasCosOrExtras={invoice.has_cos_or_extras}
                />
              </div>
            </div>

            <div className="flex flex-col">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                Status &amp; approval
              </div>
              <div className="flex flex-1 flex-col">
                {approval.currentStepApproverNames.length > 0 && (
                  <p className="mt-2 text-sm text-slate-600">
                    Currently with{" "}
                    <span className="font-medium text-slate-800">
                      {approval.currentStepApproverNames.join(", ")}
                    </span>
                  </p>
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
                {invoice.status !== "approved" &&
                  invoice.status !== "rejected" &&
                  invoice.status !== "cancelled" && (
                    <>
                      {/* Status copy sits in normal flow right under the
                          stepper; only the button row is pinned to the
                          bottom so it lines up with Approve. */}
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
                      {invoice.status !== "on_review" &&
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
                        ))}

                      {/* Every button is flex-1, so one or several, the row
                          always spans the full column width — matching the
                          Approve button opposite. Each carries a border
                          (transparent where there's no visible outline) so
                          they're all exactly the same height. */}
                      {((invoice.status === "on_review" && canReview) ||
                        approval.canDecide ||
                        approval.canUnhold ||
                        approval.canCancel) && (
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
                              <form action={approval.hold} className="flex-1">
                                <SubmitButton className="w-full rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm font-semibold text-amber-800 hover:bg-amber-100">
                                  Hold
                                </SubmitButton>
                              </form>
                              <form action={approval.reject} className="flex-1">
                                <SubmitButton className="w-full rounded-md border border-transparent bg-red-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-red-700">
                                  Reject
                                </SubmitButton>
                              </form>
                            </>
                          )}
                          {approval.canCancel && !approval.canUnhold && (
                            <form action={approval.cancel} className="flex-1">
                              <SubmitButton className="w-full rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-semibold text-slate-600 hover:bg-slate-50">
                                Cancel
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
              {invoice.source_email && (
                <p className="mt-0.5 truncate text-sm text-slate-400">
                  {invoice.source_email}
                </p>
              )}
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

          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
            <label>
              <span className={ghostLabel}>Vendor name</span>
              <Combobox
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
            </label>
            <label>
              <span className={ghostLabel}>Email</span>
              <input
                form="bill-form"
                name="source_email"
                defaultValue={invoice.source_email ?? ""}
                className={ghostField}
                {...billBlur}
              />
            </label>
          </div>
        </div>

        {/* Category details — editable line items, table-style. Project is
            per-line (a bill can split across several projects) rather than
            a single invoice-level field, so it lives here, not above. */}
        <div className="border-b border-slate-200 px-6 py-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Category details
          </div>
          <div className="mt-2">
            <div
              className={`grid ${LINE_ITEM_COLS} gap-x-2 border-b border-slate-200 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400`}
            >
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
              />
            ))}
            {!readOnly && addingLine && (
              <LineItemRow
                itemId="new"
                defaults={{
                  category: "",
                  description: "",
                  tax_rate: "",
                  qbo_tax_code_id: "",
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
              <SubmitButton className="font-medium text-slate-500 hover:text-slate-700 hover:underline">
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

        {/* QuickBooks Online sync */}
        <div className="border-t border-slate-100 px-6 py-3 text-xs">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            QuickBooks Online
          </div>
          <div className="mt-2 space-y-2">
            {invoice.qbo_sync_status === "synced" ? (
              <div className="space-y-1.5">
                <p className="flex flex-wrap items-center gap-2 text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Synced to QuickBooks
                  {invoice.qbo_synced_at
                    ? ` — ${new Date(invoice.qbo_synced_at).toLocaleDateString()} at ${new Date(
                        invoice.qbo_synced_at
                      ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : ""}
                  {qboConnected && qboRealmId && invoice.qbo_bill_id && (
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
                  <p className="text-amber-700">
                    Bill created, but attachments failed: {invoice.qbo_error}
                  </p>
                )}
                {admin.visible && admin.clearQboSync && (
                  <div>
                    <form action={admin.clearQboSync}>
                      <SubmitButton className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                        Undo sync (allow re-sync)
                      </SubmitButton>
                    </form>
                    <p className="mt-1 text-[11px] text-slate-400">
                      Only clears Flow&apos;s own record — the Bill already
                      in QuickBooks is untouched. Void or delete it there
                      yourself first if you don&apos;t want a duplicate.
                    </p>
                  </div>
                )}
              </div>
            ) : invoice.qbo_sync_status === "error" && !(invoice.status === "qbo_ready" && admin.visible) ? (
              // A failed sync only ever touches qbo_sync_status/qbo_error,
              // never invoice.status — so this is the bill-moved-on case:
              // it failed while qbo_ready, then got sent back to review (or
              // otherwise progressed) before anyone retried, leaving a
              // stale error with nothing to retry against anymore. "Clear"
              // is the only sensible action here; the qbo_ready case below
              // gets a real Retry instead.
              <div className="space-y-2">
                <p className="text-red-600">
                  Sync failed
                  {invoice.qbo_error ? `: ${invoice.qbo_error}` : ""}
                </p>
                {admin.visible && admin.clearQboError && (
                  <form action={admin.clearQboError}>
                    <SubmitButton className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                      Clear error
                    </SubmitButton>
                  </form>
                )}
              </div>
            ) : invoice.status === "qbo_ready" && admin.visible ? (
              <div className="space-y-2">
                {invoice.qbo_sync_status === "error" ? (
                  <p className="text-red-600">
                    Sync failed
                    {invoice.qbo_error ? `: ${invoice.qbo_error}` : ""}
                  </p>
                ) : (
                  <p className="text-sky-700">
                    Workflow complete — this bill is ready for the final
                    QuickBooks release.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <form action={admin.syncToQbo}>
                    <SubmitButton
                      disabled={!qboConnected}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {qboConnected
                        ? invoice.qbo_sync_status === "error"
                          ? "Retry sync to QuickBooks"
                          : "Sync to QuickBooks (final)"
                        : "Connect QuickBooks in Settings first"}
                    </SubmitButton>
                  </form>
                  {invoice.qbo_sync_status === "error" && admin.clearQboError && (
                    <form action={admin.clearQboError}>
                      <SubmitButton className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                        Clear error
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-slate-400">
                {invoice.status === "qbo_ready"
                  ? "Waiting for an admin to release this bill to QuickBooks."
                  : "Not synced to QuickBooks yet — completes after the full approval workflow."}
              </p>
            )}
            {!readOnly && (
              <p className="text-slate-400">
                Sync to QuickBooks is managed in Settings → Integrations.
              </p>
            )}
          </div>
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
                      <span className="text-xs text-slate-400">
                        {new Date(comment.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                      {renderCommentBody(comment.body)}
                    </p>
                  </div>
                ))
              )}
            </div>
            {!readOnly && (
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
                {auditTimeline.map((entry) => (
                  <li key={entry.id} className="border-l-2 border-slate-200 pl-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm text-slate-700">
                        <span className="font-medium">{entry.actorName}</span>{" "}
                        {entry.kind === "comment" ? "commented" : entry.summary}
                      </p>
                      <span className="flex-none text-[11px] text-slate-400">
                        {new Date(entry.at).toLocaleString()}
                      </span>
                    </div>
                    {entry.detail && (
                      <p className="mt-0.5 text-xs text-slate-500">{entry.detail}</p>
                    )}
                  </li>
                ))}
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
  onCancel,
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
  // The blank add-line row's "cancel" button — dismisses it without
  // saving. Only meaningful when itemId === "new".
  onCancel?: () => void;
}) {
  const isNew = itemId === "new";
  const formId = `line-item-${itemId}`;
  const formRef = useRef<HTMLFormElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  // The "Add" button below is associated with the hidden form via the
  // form="..." attribute, not by being a descendant of it — useFormStatus
  // only tracks descendants of the <form> it's actually inside, so it
  // can't see this submission. Tracked by hand instead.
  const [addPending, setAddPending] = useState(false);
  const cellCls = "w-full truncate border-b border-transparent bg-transparent px-0 py-1.5 text-xs text-slate-800 hover:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-400";
  // Description wraps and grows instead of truncating — PMs need to read
  // the whole thing, not just what fits on one line.
  const descCls = "w-full resize-none overflow-hidden whitespace-pre-wrap break-words border-b border-transparent bg-transparent px-0 py-1.5 text-xs text-slate-800 hover:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-400";

  const autoResizeDesc = () => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(autoResizeDesc, []);

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
      className={`group grid ${LINE_ITEM_COLS} items-start gap-x-2 border-b border-slate-100 py-0.5`}
    >
      <form
        id={formId}
        ref={formRef}
        action={saveLineItem.bind(null, itemId)}
        className="hidden"
      />
      <Combobox
        formId={formId}
        name="category"
        options={qboCategories ?? []}
        defaultValue={defaults.category}
        placeholder={isNew ? "Search category…" : undefined}
        className={cellCls}
        disabled={readOnly}
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
        onCommit={() => {
          if (!isNew && !readOnly) formRef.current?.requestSubmit();
        }}
      />
      <Combobox
        formId={formId}
        name="class"
        options={qboClasses ?? []}
        defaultValue={defaults.class}
        placeholder={isNew ? "Search class…" : undefined}
        className={cellCls}
        disabled={readOnly}
        onCommit={() => {
          if (!isNew && !readOnly) formRef.current?.requestSubmit();
        }}
      />
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
        onCommit={() => {
          if (!isNew && !readOnly) formRef.current?.requestSubmit();
        }}
      />
      <input
        form={formId}
        name="amount"
        type="text"
        inputMode="decimal"
        defaultValue={defaults.amount}
        className={`${cellCls} text-right tabular-nums`}
        {...blurSave}
      />
      <div className="flex justify-center pt-1.5">
        <input
          form={formId}
          name="linked"
          type="checkbox"
          defaultChecked={defaults.linked}
          className="h-3.5 w-3.5 rounded border-slate-300"
          {...checkboxSave}
        />
      </div>
      {isNew ? (
        !readOnly && (
          <div className="flex items-center justify-end gap-1.5 pt-1">
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
          <div className="flex items-center justify-end gap-1.5 pt-1 opacity-0 group-hover:opacity-100">
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
