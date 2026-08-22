"use client";

import { useRef } from "react";
import { Combobox } from "@/components/Combobox";

const INTEGRATIONS: { value: string; label: string }[] = [
  { value: "quickbooks_online", label: "QuickBooks Online" },
  { value: "xero", label: "Xero" },
  { value: "zoho_books", label: "Zoho Books" },
];

export interface SupplierSettingsRowValues {
  qboSupplierId: string;
  name: string;
  itemCount: number;
  integration: string;
  category: string;
  productService: string;
  class: string;
  taxRate: string;
  currency: string;
  paymentTermsDays: string;
}

const cellCls =
  "w-full truncate rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm text-slate-800 hover:border-slate-200 focus:border-blue-500 focus:outline-none disabled:text-slate-400";

// One row of the Suppliers settings table: every field auto-saves on
// blur/commit, same as a bill's line items — no separate Save button per
// row. Two hidden forms per row because Category/Product/Class/Tax/
// Currency/Terms write to supplier_defaults while Integration writes to
// qbo_suppliers — different tables, different server actions, but both
// key off THIS supplier so they always stay attached to the right row
// regardless of which one a given field submits to.
export function SupplierSettingsRow({
  supplier,
  qboCategories,
  qboClasses,
  qboTaxRates,
  readOnly,
  saveDefaults,
  saveIntegration,
}: {
  supplier: SupplierSettingsRowValues;
  qboCategories: string[];
  qboClasses: string[];
  qboTaxRates: { value: string; label: string }[];
  readOnly: boolean;
  saveDefaults: (vendorName: string, formData: FormData) => Promise<void>;
  saveIntegration: (qboSupplierId: string, formData: FormData) => Promise<void>;
}) {
  const defaultsFormId = `supplier-defaults-${supplier.qboSupplierId}`;
  const integrationFormId = `supplier-integration-${supplier.qboSupplierId}`;
  const defaultsFormRef = useRef<HTMLFormElement>(null);
  const integrationFormRef = useRef<HTMLFormElement>(null);

  const submitDefaults = () => {
    if (!readOnly) defaultsFormRef.current?.requestSubmit();
  };

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <form
        id={defaultsFormId}
        ref={defaultsFormRef}
        action={saveDefaults.bind(null, supplier.name)}
        className="hidden"
      />
      <form
        id={integrationFormId}
        ref={integrationFormRef}
        action={saveIntegration.bind(null, supplier.qboSupplierId)}
        className="hidden"
      />
      <td className="max-w-[220px] truncate px-2 py-2 text-sm font-medium text-slate-800" title={supplier.name}>
        {supplier.name}
      </td>
      <td className="px-2 py-2 text-center text-sm text-slate-500">{supplier.itemCount}</td>
      <td className="px-2 py-2">
        <select
          form={integrationFormId}
          name="integration"
          defaultValue={supplier.integration}
          disabled={readOnly}
          onChange={() => integrationFormRef.current?.requestSubmit()}
          className={cellCls}
        >
          {INTEGRATIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-2">
        <Combobox
          formId={defaultsFormId}
          name="category"
          options={qboCategories}
          defaultValue={supplier.category}
          placeholder="Search category…"
          disabled={readOnly}
          onCommit={submitDefaults}
          className={cellCls}
        />
      </td>
      <td className="px-2 py-2">
        <input
          form={defaultsFormId}
          name="product_service"
          defaultValue={supplier.productService}
          placeholder="—"
          disabled={readOnly}
          onBlur={submitDefaults}
          className={cellCls}
        />
      </td>
      <td className="px-2 py-2">
        <Combobox
          formId={defaultsFormId}
          name="class"
          options={qboClasses}
          defaultValue={supplier.class}
          placeholder="Search class…"
          disabled={readOnly}
          onCommit={submitDefaults}
          className={cellCls}
        />
      </td>
      <td className="px-2 py-2">
        <Combobox
          formId={defaultsFormId}
          name="tax_rate"
          options={qboTaxRates}
          defaultValue={supplier.taxRate}
          placeholder="Tax %"
          disabled={readOnly}
          showValue
          minQueryLength={1}
          onCommit={submitDefaults}
          className={`${cellCls} text-right tabular-nums`}
        />
      </td>
      <td className="px-2 py-2">
        <input
          form={defaultsFormId}
          name="currency"
          defaultValue={supplier.currency}
          placeholder="—"
          disabled={readOnly}
          onBlur={submitDefaults}
          className={`${cellCls} w-20 text-center uppercase`}
        />
      </td>
      <td className="px-2 py-2">
        <input
          form={defaultsFormId}
          name="payment_terms_days"
          type="number"
          min={0}
          defaultValue={supplier.paymentTermsDays}
          placeholder="—"
          disabled={readOnly}
          onBlur={submitDefaults}
          className={`${cellCls} w-16 text-center`}
        />
      </td>
    </tr>
  );
}
