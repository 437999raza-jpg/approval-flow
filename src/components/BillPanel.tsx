import type { Database } from "@/lib/supabase/types";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];
type LineItem = Database["public"]["Tables"]["invoice_line_items"]["Row"];

// ApprovalMax-style "Bill" panel — every data item is editable and maps to
// QBO on sync: vendor/bill number/dates/amount/currency/tax on the bill,
// category-details rows as line items, and the accounting instructions as
// the memo. Pure presentational; collapse state lives in DetailSplit.
// Authored by Araza.
export function BillPanel({
  invoice,
  documentCount,
  lineItems,
  projects,
  saveBill,
  saveLineItem,
  deleteLineItem,
  reExtract,
  reviewDone,
  backToReview,
  canReview,
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
  reviewDone: (formData: FormData) => Promise<void>;
  backToReview: () => Promise<void>;
  canReview: boolean;
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
  const amount = invoice.amount;
  const tax = invoice.tax_amount;
  const subtotal =
    amount != null && tax != null ? amount - tax : amount;
  const vendor = invoice.vendor_name ?? invoice.file_name ?? "Unknown vendor";
  const billNumber = invoice.invoice_number ?? "—";
  const billDateDefault = invoice.bill_date ?? invoice.created_at.slice(0, 10);

  const inputCls =
    "mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none";
  const labelCls =
    "block text-[10px] font-semibold uppercase tracking-wide text-slate-400";

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
        {/* Review actions — top of the bill (ApprovalMax-style) */}
        {(invoice.status === "pending_review" && canReview) ||
        (["pending", "in_review", "rejected"].includes(invoice.status) &&
          canReview) ? (
          <div className="flex flex-none items-center gap-2 border-b border-slate-200 px-4 py-2">
            {invoice.status === "pending_review" && canReview && (
              <button
                type="submit"
                form="bill-form"
                formAction={reviewDone}
                className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Review Done
              </button>
            )}
            {["pending", "in_review", "rejected"].includes(invoice.status) &&
              canReview && (
                <form action={backToReview}>
                  <button className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
                    Back to Review
                  </button>
                </form>
              )}
          </div>
        ) : null}

        {/* Editable bill fields — maps to the QBO bill on sync */}
        <form
          id="bill-form"
          action={saveBill}
          className="border-b border-slate-200 px-4 py-3"
        >
          {/* Summary (updates after save) */}
          <div className="text-sm font-semibold text-slate-800">
            Bill {billNumber} from {vendor}
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-lg font-bold text-slate-900">
              {fmt(amount)}
            </span>
            <span className="text-xs font-medium text-slate-400">
              {invoice.currency}
            </span>
          </div>

          {/* Bill details */}
          <div className="mt-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Bill details
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2">
            <label className="col-span-2">
              <span className={labelCls}>Vendor name</span>
              <input
                name="vendor_name"
                defaultValue={invoice.vendor_name ?? ""}
                className={inputCls}
              />
            </label>
            <label className="col-span-2">
              <span className={labelCls}>Email</span>
              <input
                name="source_email"
                defaultValue={invoice.source_email ?? ""}
                className={inputCls}
              />
            </label>
            <label>
              <span className={labelCls}>Bill number</span>
              <input
                name="bill_number"
                defaultValue={invoice.invoice_number ?? ""}
                className={inputCls}
              />
            </label>
            <label>
              <span className={labelCls}>Documents</span>
              <input
                value={`${documentCount} attached`}
                readOnly
                className={`${inputCls} bg-slate-50 text-slate-400`}
              />
            </label>
            <label>
              <span className={labelCls}>Bill date</span>
              <input
                type="date"
                name="bill_date"
                defaultValue={billDateDefault}
                className={inputCls}
              />
            </label>
            <label>
              <span className={labelCls}>Due date</span>
              <input
                type="date"
                name="due_date"
                defaultValue={invoice.due_date ?? ""}
                className={inputCls}
              />
            </label>
            <label className="col-span-2">
              <span className={labelCls}>Project / customer</span>
              <select
                name="project_id"
                defaultValue={invoice.project_id ?? ""}
                className={inputCls}
              >
                <option value="">— none —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Totals */}
          <div className="mt-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Amounts are Tax Exclusive
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2">
            <label>
              <span className={labelCls}>Total amount</span>
              <input
                name="amount"
                type="number"
                step="0.01"
                defaultValue={invoice.amount ?? ""}
                className={inputCls}
              />
            </label>
            <label>
              <span className={labelCls}>Currency</span>
              <input
                name="currency"
                defaultValue={invoice.currency}
                className={inputCls}
              />
            </label>
            <label>
              <span className={labelCls}>Tax</span>
              <input
                name="tax_amount"
                type="number"
                step="0.01"
                defaultValue={invoice.tax_amount ?? ""}
                className={inputCls}
              />
            </label>
            <div>
              <span className={labelCls}>Subtotal</span>
              <div className="mt-1 text-sm font-medium text-slate-700">
                {fmt(subtotal)}
              </div>
            </div>
          </div>
        </form>

        {/* Category details — editable line items */}
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Category details
          </div>
          <div className="mt-2 space-y-2">
            {lineItems.map((item) => (
              <LineItemRow
                key={item.id}
                itemId={item.id}
                defaults={{
                  category: item.category ?? "",
                  description: item.description ?? "",
                  tax_rate: item.tax_rate ?? "",
                  class: item.class ?? "",
                  amount: item.amount ?? "",
                  linked: item.linked,
                }}
                saveLineItem={saveLineItem}
                deleteLineItem={deleteLineItem}
              />
            ))}
            {/* Add-line row (empty) */}
            <LineItemRow
              itemId="new"
              defaults={{
                category: "",
                description: "",
                tax_rate: "",
                class: "",
                amount: "",
                linked: false,
              }}
              saveLineItem={saveLineItem}
              deleteLineItem={undefined}
            />
          </div>
        </div>

        {/* Links */}
        <div className="border-b border-slate-200 px-4 py-3 text-xs">
          <button
            type="button"
            onClick={onOpenDocument}
            className="block py-0.5 text-left text-xs font-medium text-blue-600 hover:underline"
          >
            Open the original document
          </button>
          <form action={reExtract}>
            <button className="block py-0.5 text-left text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline">
              Re-extract document fields
            </button>
          </form>
          <span
            className="block py-0.5 text-slate-400"
            title="Available once QBO sync is enabled"
          >
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
  saveLineItem,
  deleteLineItem,
}: {
  itemId: string;
  defaults: {
    category: string;
    description: string;
    tax_rate: number | "";
    class: string;
    amount: number | "";
    linked: boolean;
  };
  saveLineItem: (
    lineItemId: string,
    formData: FormData
  ) => Promise<void>;
  deleteLineItem?: (lineItemId: string) => Promise<void>;
}) {
  const isNew = itemId === "new";
  const inputCls =
    "mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none";
  const labelCls =
    "block text-[10px] font-semibold uppercase tracking-wide text-slate-400";

  return (
    <div className="rounded-md border border-slate-200 p-2">
      <form action={saveLineItem.bind(null, itemId)}>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
          <label>
            <span className={labelCls}>Category</span>
            <input
              name="category"
              defaultValue={defaults.category}
              className={inputCls}
            />
          </label>
          <label>
            <span className={labelCls}>Description</span>
            <input
              name="description"
              defaultValue={defaults.description}
              className={inputCls}
            />
          </label>
          <label>
            <span className={labelCls}>Tax %</span>
            <input
              name="tax_rate"
              type="number"
              step="0.01"
              defaultValue={defaults.tax_rate}
              className={inputCls}
            />
          </label>
          <label>
            <span className={labelCls}>Class</span>
            <input
              name="class"
              defaultValue={defaults.class}
              className={inputCls}
            />
          </label>
          <label>
            <span className={labelCls}>Amount</span>
            <input
              name="amount"
              type="number"
              step="0.01"
              defaultValue={defaults.amount}
              className={inputCls}
            />
          </label>
          <label className="flex items-end gap-1.5 pb-1">
            <input
              name="linked"
              type="checkbox"
              defaultChecked={defaults.linked}
              className="h-4 w-4 rounded border-slate-300"
            />
            <span className={labelCls}>Linked</span>
          </label>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700">
            {isNew ? "Add line" : "Save"}
          </button>
        </div>
      </form>
      {!isNew && deleteLineItem && (
        <form
          action={deleteLineItem.bind(null, itemId)}
          className="mt-1 text-right"
        >
          <button className="text-xs text-red-500 hover:underline">
            Delete
          </button>
        </form>
      )}
    </div>
  );
}
