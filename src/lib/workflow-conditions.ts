// Per-step, per-approver conditional routing — the TypeScript mirror of
// is_eligible_approver() in migration 0027 (that one drives RLS
// visibility in Postgres; this one drives who actually shows up as "the
// approver" for a step in the app and who's allowed to decide). Keep
// the matching semantics in sync if either changes.
// Authored by Araza.

export interface StepApprover {
  id: string; // approval_workflow_step_approvers.id
  approver_user_id: string;
  is_default: boolean;
}

export interface StepCondition {
  step_approver_id: string;
  field: "class" | "customer" | "supplier" | "category";
  operator: "matches" | "not_matches";
  match_values: string[];
}

export interface InvoiceForMatching {
  vendor_name: string | null;
  project_id: string | null; // invoice-level fallback when no line item has one
}

export interface LineItemForMatching {
  class: string | null;
  category: string | null;
  project_id: string | null;
}

function conditionMatches(
  c: StepCondition,
  vendor: string,
  classes: Set<string>,
  categories: Set<string>,
  projectIds: Set<string>
): boolean {
  if (c.field === "supplier") {
    const values = new Set(c.match_values.map((v) => v.trim().toLowerCase()));
    const hit = values.has(vendor);
    return c.operator === "matches" ? hit : !hit;
  }
  if (c.field === "class") {
    const values = new Set(c.match_values.map((v) => v.trim().toLowerCase()));
    const hit = [...classes].some((cl) => values.has(cl));
    return c.operator === "matches" ? hit : !hit;
  }
  if (c.field === "category") {
    const values = new Set(c.match_values.map((v) => v.trim().toLowerCase()));
    const hit = [...categories].some((cat) => values.has(cat));
    return c.operator === "matches" ? hit : !hit;
  }
  // customer: values are project ids — compared as-is, no case folding.
  const values = new Set(c.match_values);
  const hit = [...projectIds].some((p) => values.has(p));
  return c.operator === "matches" ? hit : !hit;
}

// The approvers actually "in play" for one step given this specific
// invoice: every non-default approver whose conditions (ANDed) all
// match, or — if none match — every default approver on the step.
export function effectiveApproversForStep(
  approvers: StepApprover[],
  conditions: StepCondition[],
  invoice: InvoiceForMatching,
  lineItems: LineItemForMatching[]
): string[] {
  const vendor = invoice.vendor_name?.trim().toLowerCase() ?? "";
  const classes = new Set(
    lineItems
      .map((l) => l.class?.trim().toLowerCase())
      .filter((c): c is string => !!c)
  );
  const categories = new Set(
    lineItems
      .map((l) => l.category?.trim().toLowerCase())
      .filter((c): c is string => !!c)
  );
  let projectIds = new Set(
    lineItems.map((l) => l.project_id).filter((p): p is string => !!p)
  );
  if (projectIds.size === 0 && invoice.project_id) {
    projectIds = new Set([invoice.project_id]);
  }

  const conditionsByApprover = new Map<string, StepCondition[]>();
  for (const c of conditions) {
    const list = conditionsByApprover.get(c.step_approver_id) ?? [];
    list.push(c);
    conditionsByApprover.set(c.step_approver_id, list);
  }

  const matching: string[] = [];
  for (const a of approvers) {
    if (a.is_default) continue;
    const conds = conditionsByApprover.get(a.id) ?? [];
    if (conds.every((c) => conditionMatches(c, vendor, classes, categories, projectIds))) {
      matching.push(a.approver_user_id);
    }
  }
  if (matching.length > 0) return [...new Set(matching)];

  return [
    ...new Set(approvers.filter((a) => a.is_default).map((a) => a.approver_user_id)),
  ];
}

// Given a step's approval_mode and the set of approvers actually required
// for this invoice, what has this step's existing decisions resolved to?
// A single reject from any required approver rejects the step outright,
// regardless of mode.
export function stepDecisionState(
  approvalMode: "any" | "all",
  requiredApproverIds: string[],
  decisions: { approver_id: string | null; decision: string }[]
): "pending" | "approved" | "rejected" {
  if (decisions.some((d) => d.decision === "rejected")) return "rejected";
  const approvedIds = new Set(
    decisions.filter((d) => d.decision === "approved").map((d) => d.approver_id)
  );
  if (requiredApproverIds.length === 0) return "pending";
  if (approvalMode === "any") {
    return approvedIds.size > 0 ? "approved" : "pending";
  }
  const allApproved = requiredApproverIds.every((id) => approvedIds.has(id));
  return allApproved ? "approved" : "pending";
}
