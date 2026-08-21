"use client";

import { useState } from "react";

export interface SupplierDefaultsValues {
  category: string;
  class: string;
  project_id: string;
  tax_rate: string;
  payment_terms_days: string;
  currency: string;
}

export function SupplierRulesModal({
  vendorName,
  initial,
  projects,
  saveAction,
}: {
  vendorName: string;
  initial: SupplierDefaultsValues;
  projects: { id: string; name: string }[];
  saveAction: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-blue-600 hover:underline"
      >
        Supplier rules
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="truncate text-base font-semibold">
                Supplier rules: <span className="font-normal">{vendorName}</span>
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="ml-2 flex-none text-lg leading-none text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>

            <form
              action={async (formData) => {
                await saveAction(formData);
                setOpen(false);
              }}
              className="space-y-3 p-6"
            >
              <p className="text-xs text-slate-500">
                Applied automatically to future invoices from this supplier — Category,
                Class, and Tax rate fill in on every line item, and Payment terms
                computes the due date. Leave a field blank to leave it to extraction.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Category
                  </label>
                  <input
                    name="category"
                    defaultValue={initial.category}
                    placeholder="e.g. Roofing"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Class
                  </label>
                  <input
                    name="class"
                    defaultValue={initial.class}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Project / customer
                </label>
                <select
                  name="project_id"
                  defaultValue={initial.project_id}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">— none —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Tax rate (%)
                  </label>
                  <input
                    name="tax_rate"
                    type="number"
                    step="0.01"
                    defaultValue={initial.tax_rate}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Currency
                  </label>
                  <input
                    name="currency"
                    defaultValue={initial.currency}
                    placeholder="e.g. CAD"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Payment terms
                </label>
                <div className="flex items-center gap-2">
                  <input
                    name="payment_terms_days"
                    type="number"
                    min={0}
                    defaultValue={initial.payment_terms_days}
                    className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <span className="text-sm text-slate-500">days after invoice date</span>
                </div>
              </div>

              <label className="flex items-start gap-2 pt-1 text-sm text-slate-700">
                <input
                  name="apply_to_inbox"
                  type="checkbox"
                  defaultChecked
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                Apply to all invoices still in review from this supplier
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  Apply
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
