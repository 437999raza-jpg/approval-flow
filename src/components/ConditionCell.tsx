"use client";

import { useState } from "react";
import { TagInput, type TagOption } from "@/components/TagInput";

type ConditionOperator = "any" | "matches" | "not_matches";

// One matrix cell: an operator select plus (when the operator isn't "any")
// the chip picker for its values. Used for the Class/Supplier/Customer
// columns in StepApproverMatrixRow. Authored by Araza.
export function ConditionCell({
  name,
  initialOperator,
  initialValues,
  placeholder,
  options,
}: {
  name: "class" | "supplier" | "customer" | "category";
  initialOperator: ConditionOperator;
  initialValues: string[];
  placeholder?: string;
  options?: TagOption[];
}) {
  const [operator, setOperator] = useState<ConditionOperator>(initialOperator);
  return (
    <div className="min-w-40 space-y-1">
      <select
        name={`${name}_operator`}
        value={operator}
        onChange={(e) => setOperator(e.target.value as ConditionOperator)}
        className="rounded-md border border-slate-300 px-1.5 py-0.5 text-xs"
      >
        <option value="any">Any</option>
        <option value="matches">Matches</option>
        <option value="not_matches">Does not match</option>
      </select>
      {operator !== "any" && (
        <TagInput
          name={`${name}_values`}
          initialValues={initialValues}
          placeholder={placeholder}
          options={options}
        />
      )}
    </div>
  );
}
