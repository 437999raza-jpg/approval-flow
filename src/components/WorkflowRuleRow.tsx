"use client";

import { useState } from "react";
import {
  RULE_TYPES,
  OPERATORS_BY_TYPE,
  needsValue,
  type RuleOperator,
  type RuleType,
} from "@/lib/workflow-rules";
import { SubmitButton } from "@/components/SubmitButton";

// One editable workflow rule row (ApprovalMax-style "workflow item"):
// field (Total Amount / Requester / Supplier / …) + operator + value(s).
// The operator list and value inputs adapt to the chosen field. Client
// component so the form reacts without a page reload. Authored by Araza.
export function WorkflowRuleRow({
  ruleId,
  initialType,
  initialOperator,
  initialValue,
  initialValue2,
  saveRule,
  deleteRule,
}: {
  ruleId: string; // "new" for the add-line row
  initialType: RuleType;
  initialOperator: RuleOperator;
  initialValue: string | null;
  initialValue2: string | null;
  saveRule: (ruleId: string, formData: FormData) => Promise<void>;
  deleteRule?: (ruleId: string) => Promise<void>;
}) {
  const [type, setType] = useState<RuleType>(initialType);
  const [operator, setOperator] = useState<RuleOperator>(initialOperator);

  const operators = OPERATORS_BY_TYPE[type] ?? OPERATORS_BY_TYPE.total_amount;
  const showValue = needsValue(operator);
  const showValue2 = operator === "between";
  const isNew = ruleId === "new";

  const onTypeChange = (value: RuleType) => {
    setType(value);
    const first = OPERATORS_BY_TYPE[value]?.[0]?.value ?? "any";
    setOperator(first);
  };

  const inputCls =
    "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-2">
      <form
        action={saveRule.bind(null, ruleId)}
        className="flex flex-wrap items-center gap-2"
      >
        <select
          name="rule_type"
          value={type}
          onChange={(e) => onTypeChange(e.target.value as RuleType)}
          className={inputCls}
        >
          {RULE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          name="operator"
          value={operator}
          onChange={(e) => setOperator(e.target.value as RuleOperator)}
          className={inputCls}
        >
          {operators.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {showValue && (
          <input
            name="value"
            defaultValue={initialValue ?? ""}
            placeholder={
              type === "total_amount" ? "e.g. 1000.00" : "text to match"
            }
            className={`${inputCls} w-36`}
          />
        )}
        {showValue2 && (
          <input
            name="value2"
            defaultValue={initialValue2 ?? ""}
            placeholder="upper bound"
            className={`${inputCls} w-36`}
          />
        )}
        <SubmitButton className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700">
          {isNew ? "Add item" : "Save"}
        </SubmitButton>
      </form>
      {!isNew && deleteRule && (
        <form action={deleteRule.bind(null, ruleId)}>
          <SubmitButton className="text-xs text-red-500 hover:underline">
            Remove
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
