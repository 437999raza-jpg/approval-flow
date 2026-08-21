import { useRef } from "react";
import { SupplierRulesModal, type SupplierDefaultsValues } from "./SupplierRulesModal";
import type { Database } from "@/lib/supabase/types";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];
type LineItem = Database["public"]["Tables"]["invoice_line_items"]["Row"];

// Ghost fields: invisible border at rest, a line appears on hover/focus.
// The point is to read like a finished invoice document, not a form full
// of boxes — every value here is still fully editable in place.
const ghostField =
  "w-full border-b border-transparent bg-transparent px-0 py-1 text-sm text-slate-800 hover:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-500";
const ghostLabel = "block text-[10px] font-semibold uppercase tracking-wide text-slate-400";
const LINE_ITEM_COLS = "grid-cols-[1.1fr_1.4fr_1.1fr_64px_0.9fr_110px_52px_24px]";

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
  saveBill,
  saveLineItem,
  deleteLineItem,
  reExtract,
  backToReview,
  canReview,
  readOnly,
  supplierDefaults,
  saveSupplierDefaults,
  onOpenDocument,
  onCollapse,
}: {
  invoice: Invoice;
  documentCount: number;
  lineItems: LineItem[];
  projects: { id: string; name: string }[];
  saveBill: (formData: FormData) => Promise<void>;
  saveLineItem: (
    lineItemId: string,
    formData: FormData
  ) => Promise<void>;
  deleteLineItem: (lineItemId: string) => Promise<void>;
  reExtract: () => Promise<void>;
  backToReview: () => Promise<void>;
  canReview: boolean;
  readOnly: boolean;
  supplierDefaults: SupplierDefaultsValues;
  saveSupplierDefaults: (formData: FormData) => Promise<void>;
  onOpenDocument: () => void;
  onCollapse: () => void;
}) {
  const fmt = (n: number | null) =>
    n != null
      ? n.toLocaleString(undefined, {
          style: "currency",
          currency: invoice.currency,
        })
      : "—";
  const num2 = (n: number | null) => (n != null ? n.toFixed(2) : "");
  const amount = invoice.amount;
  const tax = invoice.tax_amount;
  const subtotal =
    amount != null && tax != null ? amount - tax : amount;
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

      <div className="min-h-0 flex-1 overflow-y-auto">
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
                    initial={supplierDefaults}
                    projects={projects}
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
            </div>
          </div>

          {["on_approval", "on_hold", "rejected"].includes(invoice.status) &&
            canReview &&
            !readOnly && (
              <form action={backToReview} className="mt-3">
                <button className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                  Back to Review
                </button>
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
              <input
                form="bill-form"
                name="vendor_name"
                defaultValue={invoice.vendor_name ?? ""}
                className={`${ghostField} font-medium`}
                {...billBlur}
              />
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
          <div className="mt-2 overflow-x-auto">
            <div
              className={`grid ${LINE_ITEM_COLS} min-w-[720px] gap-x-3 border-b border-slate-200 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400`}
            >
              <span>Category</span>
              <span>Description</span>
              <span>Project / customer</span>
              <span className="text-right">Tax %</span>
              <span>Class</span>
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
                  class: item.class ?? "",
                  project_id: item.project_id ?? "",
                  amount: item.amount != null ? item.amount.toFixed(2) : "",
                  linked: item.linked,
                }}
                projects={projects}
                saveLineItem={saveLineItem}
                deleteLineItem={deleteLineItem}
                readOnly={readOnly}
              />
            ))}
            {!readOnly && (
              <LineItemRow
                itemId="new"
                defaults={{
                  category: "",
                  description: "",
                  tax_rate: "",
                  class: "",
                  project_id: "",
                  amount: "",
                  linked: false,
                }}
                projects={projects}
                saveLineItem={saveLineItem}
                deleteLineItem={undefined}
                readOnly={false}
              />
            )}
          </div>

          {/* Totals — Amount/Tax post through bill-form via the `form`
              attribute even though they render down here, after the table. */}
          <div className="mt-4 flex justify-end">
            <div className="w-56 space-y-1.5">
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>Subtotal</span>
                <span className="tabular-nums">{num2(subtotal)}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>Tax</span>
                <input
                  form="bill-form"
                  name="tax_amount"
                  type="text"
                  inputMode="decimal"
                  defaultValue={num2(invoice.tax_amount)}
                  className="w-[6ch] border-b border-transparent bg-transparent text-right text-sm tabular-nums text-slate-700 hover:border-slate-200 focus:border-blue-500 focus:outline-none"
                  {...billBlur}
                />
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 text-base font-semibold text-slate-900">
                <span>Total</span>
                <input
                  form="bill-form"
                  name="amount"
                  type="text"
                  inputMode="decimal"
                  defaultValue={num2(invoice.amount)}
                  className="w-[8ch] border-b border-transparent bg-transparent text-right font-semibold tabular-nums hover:border-slate-200 focus:border-blue-500 focus:outline-none"
                  {...billBlur}
                />
                {/* currency is shown once, in the header — not repeated
                    here — but still submits with the form so autosaving
                    other fields doesn't reset it. */}
                <input
                  form="bill-form"
                  type="hidden"
                  name="currency"
                  value={invoice.currency}
                  readOnly
                />
              </div>
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
              <button className="font-medium text-slate-500 hover:text-slate-700 hover:underline">
                Re-extract document fields
              </button>
            </form>
          )}
          <span className="text-slate-400" title="Available once QBO sync is enabled">
            Open in QuickBooks Online
          </span>
        </div>
      </div>
    </div>
  );
}

function LineItemRow({
  itemId,
  defaults,
  projects,
  saveLineItem,
  deleteLineItem,
  readOnly,
}: {
  itemId: string;
  defaults: {
    category: string;
    description: string;
    tax_rate: number | "";
    class: string;
    project_id: string;
    amount: string;
    linked: boolean;
  };
  projects: { id: string; name: string }[];
  saveLineItem: (
    lineItemId: string,
    formData: FormData
  ) => Promise<void>;
  deleteLineItem?: (lineItemId: string) => Promise<void>;
  readOnly: boolean;
}) {
  const isNew = itemId === "new";
  const formId = `line-item-${itemId}`;
  const formRef = useRef<HTMLFormElement>(null);
  const cellCls = "border-b border-transparent bg-transparent px-0 py-1.5 text-xs text-slate-800 hover:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-400";

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
      className={`group grid ${LINE_ITEM_COLS} items-center gap-x-3 border-b border-slate-100 py-0.5`}
    >
      <form
        id={formId}
        ref={formRef}
        action={saveLineItem.bind(null, itemId)}
        className="hidden"
      />
      <input
        form={formId}
        name="category"
        defaultValue={defaults.category}
        placeholder={isNew ? "Category" : undefined}
        className={cellCls}
        {...blurSave}
      />
      <input
        form={formId}
        name="description"
        defaultValue={defaults.description}
        placeholder={isNew ? "Description" : undefined}
        className={cellCls}
        {...blurSave}
      />
      <select
        form={formId}
        name="project_id"
        defaultValue={defaults.project_id}
        className={cellCls}
        {...checkboxSave}
      >
        <option value="">— none —</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        form={formId}
        name="tax_rate"
        type="number"
        step="0.01"
        defaultValue={defaults.tax_rate}
        className={`${cellCls} text-right tabular-nums`}
        {...blurSave}
      />
      <input
        form={formId}
        name="class"
        defaultValue={defaults.class}
        placeholder={isNew ? "Class" : undefined}
        className={cellCls}
        {...blurSave}
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
      <div className="flex justify-center">
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
          <button
            form={formId}
            type="submit"
            title="Add line"
            className="justify-self-end text-sm font-medium text-blue-600 hover:underline"
          >
            +
          </button>
        )
      ) : (
        !readOnly &&
        deleteLineItem && (
          <form action={deleteLineItem.bind(null, itemId)} className="justify-self-end">
            <button
              type="submit"
              title="Delete line"
              className="text-slate-300 opacity-0 hover:text-red-500 group-hover:opacity-100"
            >
              ×
            </button>
          </form>
        )
      )}
    </div>
  );
}
