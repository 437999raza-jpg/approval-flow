// Workflow routing-rule definitions (ApprovalMax-style "workflow items").
// A workflow matches an invoice when ALL of its rules match; the first
// matching workflow routes the invoice. Authored by Araza.

export type RuleType =
  | "total_amount"
  | "requester"
  | "supplier"
  | "product_service"
  | "category"
  | "class"
  | "customer";

export type RuleOperator =
  | "any"
  | "between"
  | "under"
  | "over"
  | "equal"
  | "matches"
  | "not_matches";

export const RULE_TYPES: { value: RuleType; label: string }[] = [
  { value: "total_amount", label: "Total Amount" },
  { value: "requester", label: "Requester" },
  { value: "supplier", label: "Supplier" },
  { value: "product_service", label: "Product/Service" },
  { value: "category", label: "Category" },
  { value: "class", label: "Class" },
  { value: "customer", label: "Customer" },
];

export const OPERATOR_LABELS: Record<RuleOperator, string> = {
  any: "Any",
  between: "Between",
  under: "Under",
  over: "Over",
  equal: "Equal to",
  matches: "Matches",
  not_matches: "Does not match",
};

// Which operators apply to which rule type.
export const OPERATORS_BY_TYPE: Record<
  RuleType,
  { value: RuleOperator; label: string }[]
> = {
  total_amount: [
    { value: "any", label: OPERATOR_LABELS.any },
    { value: "between", label: OPERATOR_LABELS.between },
    { value: "under", label: OPERATOR_LABELS.under },
    { value: "over", label: OPERATOR_LABELS.over },
    { value: "equal", label: OPERATOR_LABELS.equal },
  ],
  requester: [
    { value: "any", label: OPERATOR_LABELS.any },
    { value: "matches", label: OPERATOR_LABELS.matches },
    { value: "not_matches", label: OPERATOR_LABELS.not_matches },
  ],
  supplier: [
    { value: "any", label: OPERATOR_LABELS.any },
    { value: "matches", label: OPERATOR_LABELS.matches },
    { value: "not_matches", label: OPERATOR_LABELS.not_matches },
  ],
  product_service: [
    { value: "any", label: OPERATOR_LABELS.any },
    { value: "matches", label: OPERATOR_LABELS.matches },
    { value: "not_matches", label: OPERATOR_LABELS.not_matches },
  ],
  category: [
    { value: "any", label: OPERATOR_LABELS.any },
    { value: "matches", label: OPERATOR_LABELS.matches },
    { value: "not_matches", label: OPERATOR_LABELS.not_matches },
  ],
  class: [
    { value: "any", label: OPERATOR_LABELS.any },
    { value: "matches", label: OPERATOR_LABELS.matches },
    { value: "not_matches", label: OPERATOR_LABELS.not_matches },
  ],
  customer: [
    { value: "any", label: OPERATOR_LABELS.any },
    { value: "matches", label: OPERATOR_LABELS.matches },
    { value: "not_matches", label: OPERATOR_LABELS.not_matches },
  ],
};

export const RULE_TYPE_VALUES: RuleType[] = RULE_TYPES.map((t) => t.value);
export const RULE_OPERATOR_VALUES: RuleOperator[] = Object.keys(
  OPERATOR_LABELS
) as RuleOperator[];

// Which operators need a value (and whether they need a second one for
// "between").
export function needsValue(operator: RuleOperator): boolean {
  return (
    operator === "matches" ||
    operator === "not_matches" ||
    operator === "under" ||
    operator === "over" ||
    operator === "equal"
  );
}
