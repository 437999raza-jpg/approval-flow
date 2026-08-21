"use client";

import { useState } from "react";
import { ConditionCell } from "@/components/ConditionCell";
import type { TagOption } from "@/components/TagInput";

export interface RowCondition {
  field: "class" | "customer" | "supplier" | "category";
  operator: "matches" | "not_matches";
  match_values: string[];
}

// One row of the approval matrix (see StepApproversManager) — a `<form>`
// with display:contents so its cells slot straight into the parent grid as
// if they were direct grid items, letting each row submit independently
// without nesting a <form> inside table markup. Authored by Araza.
export function StepApproverMatrixRow({
  approverRowId,
  approverOptions,
  projectOptions,
  initialApproverUserId,
  initialIsDefault,
  initialConditions,
  saveApprover,
  deleteApprover,
  readOnly,
  onCancelNew,
}: {
  approverRowId: string; // "new" for an unsaved add-row
  approverOptions: { id: string; label: string }[];
  projectOptions: TagOption[];
  initialApproverUserId: string;
  initialIsDefault: boolean;
  initialConditions: RowCondition[];
  saveApprover?: (approverRowId: string, formData: FormData) => Promise<void>;
  deleteApprover?: (approverRowId: string) => Promise<void>;
  readOnly?: boolean;
  onCancelNew?: () => void;
}) {
  const isNew = approverRowId === "new";
  const [isDefault, setIsDefault] = useState(initialIsDefault);
  const findCond = (field: RowCondition["field"]) =>
    initialConditions.find((c) => c.field === field);

  const approverLabel =
    approverOptions.find((a) => a.id === initialApproverUserId)?.label ?? "Unassigned";

  const opLabel = (op: "matches" | "not_matches") =>
    op === "matches" ? "Matches" : "Does not match";
  const projectLabel = (id: string) =>
    projectOptions.find((p) => p.id === id)?.label ?? id.slice(0, 8);

  if (readOnly) {
    const classCond = findCond("class");
    const categoryCond = findCond("category");
    const supplierCond = findCond("supplier");
    const customerCond = findCond("customer");
    return (
      <div className="contents">
        <div className="border-t border-slate-100 py-2 text-sm text-slate-700">
          {approverLabel}
          {isDefault && (
            <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
              default
            </span>
          )}
        </div>
        <div className="border-t border-slate-100 py-2 text-xs text-slate-500">
          {isDefault ? "—" : classCond ? `${opLabel(classCond.operator)} ${classCond.match_values.join(", ")}` : "Any"}
        </div>
        <div className="border-t border-slate-100 py-2 text-xs text-slate-500">
          {isDefault
            ? "—"
            : categoryCond
              ? `${opLabel(categoryCond.operator)} ${categoryCond.match_values.join(", ")}`
              : "Any"}
        </div>
        <div className="border-t border-slate-100 py-2 text-xs text-slate-500">
          {isDefault
            ? "—"
            : supplierCond
              ? `${opLabel(supplierCond.operator)} ${supplierCond.match_values.join(", ")}`
              : "Any"}
        </div>
        <div className="border-t border-slate-100 py-2 text-xs text-slate-500">
          {isDefault
            ? "—"
            : customerCond
              ? `${opLabel(customerCond.operator)} ${customerCond.match_values.map(projectLabel).join(", ")}`
              : "Any"}
        </div>
        <div className="border-t border-slate-100 py-2" />
      </div>
    );
  }

  return (
    <form action={saveApprover?.bind(null, approverRowId)} className="contents">
      <div className="border-t border-slate-100 py-2">
        {isNew ? (
          <select
            name="approver_user_id"
            defaultValue={initialApproverUserId}
            required
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="">— choose —</option>
            {approverOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-slate-700">
            {approverLabel}
            <input type="hidden" name="approver_user_id" value={initialApproverUserId} />
          </span>
        )}
      </div>
      <div className="border-t border-slate-100 py-2">
        {isDefault ? (
          <span className="text-xs text-slate-400">—</span>
        ) : (
          <ConditionCell
            name="class"
            initialOperator={findCond("class")?.operator ?? "any"}
            initialValues={findCond("class")?.match_values ?? []}
            placeholder="GE, HB…"
          />
        )}
      </div>
      <div className="border-t border-slate-100 py-2">
        {isDefault ? (
          <span className="text-xs text-slate-400">—</span>
        ) : (
          <ConditionCell
            name="category"
            initialOperator={findCond("category")?.operator ?? "any"}
            initialValues={findCond("category")?.match_values ?? []}
            placeholder="Materials, Labor…"
          />
        )}
      </div>
      <div className="border-t border-slate-100 py-2">
        {isDefault ? (
          <span className="text-xs text-slate-400">—</span>
        ) : (
          <ConditionCell
            name="supplier"
            initialOperator={findCond("supplier")?.operator ?? "any"}
            initialValues={findCond("supplier")?.match_values ?? []}
            placeholder="Vendor name…"
          />
        )}
      </div>
      <div className="border-t border-slate-100 py-2">
        {isDefault ? (
          <span className="text-xs text-slate-400">—</span>
        ) : (
          <ConditionCell
            name="customer"
            initialOperator={findCond("customer")?.operator ?? "any"}
            initialValues={findCond("customer")?.match_values ?? []}
            placeholder="Search projects…"
            options={projectOptions}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 py-2">
        <label className="flex items-center gap-1 text-[11px] text-slate-500">
          <input
            type="checkbox"
            name="is_default"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-3 w-3 rounded border-slate-300"
          />
          default
        </label>
        <button className="rounded-md bg-slate-800 px-2 py-1 text-[11px] font-medium text-white hover:bg-slate-700">
          {isNew ? "Add" : "Save"}
        </button>
        {!isNew && deleteApprover && (
          <button
            type="submit"
            formAction={deleteApprover.bind(null, approverRowId)}
            className="text-[11px] text-red-500 hover:underline"
          >
            Remove
          </button>
        )}
        {isNew && onCancelNew && (
          <button
            type="button"
            onClick={onCancelNew}
            className="text-[11px] text-slate-400 hover:underline"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
