"use client";

import { useState } from "react";
import { Combobox } from "@/components/Combobox";
import { DirtySaveButton } from "@/components/DirtySaveButton";

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
  qboCategories,
  qboClasses,
  qboTaxRates,
  initialValues,
  saveAction,
}: {
  vendorName: string;
  // QBO mirrors (read-only) for searchable pick-lists, same as the bill.
  qboCategories?: string[];
  qboClasses?: string[];
  qboTaxRates?: { value: string; label: string }[];
  // Whatever's already saved for this supplier (or, if nothing's saved
  // yet, sensible values pulled from the current invoice) — the dialog
  // always reflects what's actually stored, not a blank slate.
  initialValues: SupplierDefaultsValues;
  saveAction: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const formId = "supplier-rules-form";

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
            className="w-full max-w-md rounded-lg bg-white shadow-elevation-3"
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
              id={formId}
              action={async (formData) => {
                await saveAction(formData);
                setOpen(false);
              }}
              className="space-y-3 p-6"
            >
              <p className="text-xs text-slate-500">
                Saved for this supplier and applied automatically to its
                future invoices — only the fields you set here are saved,
                blank ones are left to extraction. This is the same record
                shown in Settings → Suppliers, so it&apos;s always in sync
                either way. Project is still chosen per bill, never as a
                supplier rule.
              </p>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Category
                </label>
                <Combobox
                  formId={formId}
                  name="category"
                  options={qboCategories ?? []}
                  defaultValue={initialValues.category}
                  placeholder="Search category…"
                  onCommit={() => {}}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Class
                </label>
                <Combobox
                  formId={formId}
                  name="class"
                  options={qboClasses ?? []}
                  defaultValue={initialValues.class}
                  placeholder="Search class…"
                  onCommit={() => {}}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Tax rate (%)
                  </label>
                  <Combobox
                    formId={formId}
                    name="tax_rate"
                    options={qboTaxRates ?? []}
                    defaultValue={initialValues.tax_rate}
                    placeholder="Tax %"
                    onCommit={() => {}}
                    showValue
                    minQueryLength={1}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Currency
                  </label>
                  <input
                    name="currency"
                    defaultValue={initialValues.currency}
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
                    defaultValue={initialValues.payment_terms_days}
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
                Also apply to all invoices still in review from this supplier
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
                >
                  Cancel
                </button>
                <DirtySaveButton className="px-4 py-2 text-sm" />
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
