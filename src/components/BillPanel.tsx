"use client";

import { useState } from "react";
import type { Database } from "@/lib/supabase/types";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];

// ApprovalMax-style "Bill" panel: the QBO bill as it will appear in the
// accounting system. This is exactly what gets pushed to QuickBooks on sync
// — vendor, bill actions, category line items, and tax-exclusive totals —
// together with every attached document + the audit-trail PDF. Collapses to
// a slim strip (client state). Authored by Araza.
export function BillPanel({
  invoice,
  primaryFileUrl,
  documentCount,
}: {
  invoice: Invoice;
  primaryFileUrl: string | null;
  documentCount: number;
}) {
  const [open, setOpen] = useState(true);

  const amount =
    invoice.amount != null
      ? invoice.amount.toLocaleString(undefined, {
          style: "currency",
          currency: invoice.currency,
        })
      : "—";
  const vendor = invoice.vendor_name ?? invoice.file_name ?? "Unknown vendor";
  const billNumber = invoice.invoice_number ?? "—";

  if (!open) {
    return (
      <div className="flex flex-none flex-col items-center gap-3 border-r border-slate-200 bg-white py-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Show bill"
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="text-[11px] font-medium text-slate-400 [writing-mode:vertical-rl]">
          Bill
        </span>
      </div>
    );
  }

  return (
    <div className="flex w-[380px] flex-none flex-col border-r border-slate-200 bg-white">
      <div className="flex flex-none items-center justify-between border-b border-slate-200 px-4 py-2">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">
          Bill
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
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
    </div>
  );
}
