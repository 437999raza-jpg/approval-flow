import type { Database } from "@/lib/supabase/types";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];

// ApprovalMax-style "Bill" panel: the QBO bill as it will appear in the
// accounting system. This is exactly what gets pushed to QuickBooks on sync
// — vendor, bill actions, category line items, and tax-exclusive totals —
// together with every attached document + the audit-trail PDF.
// Authored by Araza.
export function BillPanel({
  invoice,
  primaryFileUrl,
  documentCount,
}: {
  invoice: Invoice;
  primaryFileUrl: string | null;
  documentCount: number;
}) {
  const amount =
    invoice.amount != null
      ? invoice.amount.toLocaleString(undefined, {
          style: "currency",
          currency: invoice.currency,
        })
      : "—";
  const vendor = invoice.vendor_name ?? invoice.file_name ?? "Unknown vendor";
  const billNumber = invoice.invoice_number ?? "—";

  return (
    <div className="w-[380px] flex-none overflow-y-auto border-r border-slate-200 bg-white">
      {/* Bill header */}
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-sm font-semibold text-slate-800">
          Bill {billNumber} from {vendor}
        </div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-lg font-bold text-slate-900">{amount}</span>
          <span className="text-xs font-medium text-slate-400">
            {invoice.currency}
          </span>
        </div>
      </div>

      {/* Vendor */}
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Vendor
        </div>
        <div className="mt-1 text-sm font-medium text-slate-800">{vendor}</div>
        {invoice.source_email && (
          <div className="mt-0.5 truncate text-xs text-slate-500">
            {invoice.source_email}
          </div>
        )}
      </div>

      {/* Bill actions */}
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Bill actions
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <dt className="text-xs text-slate-500">Bill date</dt>
          <dd>{new Date(invoice.created_at).toLocaleDateString()}</dd>
          <dt className="text-xs text-slate-500">Due date</dt>
          <dd>
            {invoice.due_date
              ? new Date(invoice.due_date).toLocaleDateString()
              : "—"}
          </dd>
          <dt className="text-xs text-slate-500">Bill number</dt>
          <dd>{billNumber}</dd>
          <dt className="text-xs text-slate-500">Documents</dt>
          <dd>{documentCount}</dd>
        </dl>
      </div>

      {/* Category details */}
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Category details
        </div>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
              <th className="py-1 pr-2 font-semibold">Category</th>
              <th className="py-1 pr-2 font-semibold">Description</th>
              <th className="py-1 pr-2 font-semibold">Tax</th>
              <th className="py-1 pr-2 font-semibold">Class</th>
              <th className="py-1 pr-2 text-right font-semibold">
                Amount {invoice.currency}
              </th>
              <th className="py-1 text-right font-semibold">Linked</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-100 text-slate-700">
              <td className="py-1.5 pr-2 text-slate-400">—</td>
              <td className="py-1.5 pr-2">
                {invoice.vendor_name ?? invoice.file_name}
              </td>
              <td className="py-1.5 pr-2 text-slate-400">—</td>
              <td className="py-1.5 pr-2 text-slate-400">—</td>
              <td className="py-1.5 pr-2 text-right">{amount}</td>
              <td className="py-1.5 text-right text-slate-400">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Links */}
      <div className="border-b border-slate-200 px-4 py-3 text-xs">
        {primaryFileUrl ? (
          <a
            href={primaryFileUrl}
            target="_blank"
            rel="noreferrer"
            className="block py-0.5 text-blue-600 hover:underline"
          >
            Open the original document
          </a>
        ) : (
          <span className="block py-0.5 text-slate-400">
            Open the original document
          </span>
        )}
        <span
          className="block py-0.5 text-slate-400"
          title="Available once QBO sync is enabled"
        >
          Open in QuickBooks Online
        </span>
      </div>

      {/* Totals */}
      <div className="px-4 py-3 text-xs">
        <div className="text-[10px] uppercase tracking-wide text-slate-400">
          Amounts are Tax Exclusive
        </div>
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Subtotal:</dt>
            <dd>{amount}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Tax:</dt>
            <dd>—</dd>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-bold text-slate-900">
            <dt>Total ({invoice.currency}):</dt>
            <dd>{amount}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
