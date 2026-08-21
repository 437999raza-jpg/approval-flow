import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Routing engine: picks the approval workflow for an invoice. Workflows are
// evaluated in creation order; the FIRST workflow whose items ALL match
// wins. If none match, the org's default workflow is used.
//
// Rule evaluation uses whatever invoice data exists at the moment of
// routing (amount, vendor, submitter, project, line items). Fields without
// data can only match via "any" — e.g. customer/category/class/product
// rules fall through until that data is captured.
// Authored by Araza.

type Rule = Database["public"]["Tables"]["approval_workflow_rules"]["Row"];

export interface RoutingContext {
  amount: number | null;
  vendorName: string | null;
  submittedBy: string | null;
  submitterName: string | null;
  // A bill can split across multiple projects (one per line item) — a
  // "customer" rule matches if ANY of them match, not just a single
  // invoice-level project.
  projects: { id: string | null; name: string | null }[];
  lineItems: {
    category: string | null;
    description: string | null;
    class: string | null;
    amount: number | null;
  }[];
}

export async function selectWorkflowForInvoice(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  ctx: RoutingContext
): Promise<string | null> {
  const { data: workflows } = await supabase
    .from("approval_workflows")
    .select("id, is_default")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  const ids = (workflows ?? []).map((w) => w.id);
  const { data: rules } =
    ids.length > 0
      ? await supabase
          .from("approval_workflow_rules")
          .select("*")
          .in("workflow_id", ids)
          .order("rule_order", { ascending: true })
      : { data: [] };

  const rulesByWorkflow = new Map<string, Rule[]>();
  for (const rule of rules ?? []) {
    const list = rulesByWorkflow.get(rule.workflow_id) ?? [];
    list.push(rule);
    rulesByWorkflow.set(rule.workflow_id, list);
  }

  for (const wf of workflows ?? []) {
    const wfRules = rulesByWorkflow.get(wf.id) ?? [];
    if (wfRules.every((rule) => ruleMatches(rule, ctx))) {
      return wf.id;
    }
  }

  // Fallback: the default workflow.
  return (workflows ?? []).find((w) => w.is_default)?.id ?? null;
}

function ruleMatches(rule: Rule, ctx: RoutingContext): boolean {
  const v = rule.value?.trim() ?? "";
  const v2 = rule.value2?.trim() ?? "";

  switch (rule.rule_type) {
    case "total_amount":
      return amountMatches(rule.operator, ctx.amount, v, v2);
    case "requester":
      return textAny(rule.operator, [ctx.submittedBy, ctx.submitterName], v);
    case "supplier":
      return textAny(rule.operator, [ctx.vendorName], v);
    case "customer":
      return textAny(
        rule.operator,
        ctx.projects.flatMap((p) => [p.id, p.name]),
        v
      );
    case "category":
      return lineAny(rule.operator, ctx.lineItems.map((l) => l.category), v);
    case "product_service":
      return lineAny(
        rule.operator,
        ctx.lineItems.map((l) => l.description),
        v
      );
    case "class":
      return lineAny(rule.operator, ctx.lineItems.map((l) => l.class), v);
    default:
      return true;
  }
}

function amountMatches(
  operator: Rule["operator"],
  amount: number | null,
  v1: string,
  v2: string
): boolean {
  if (operator === "any") return true;
  if (amount == null) return false; // no amount to compare against
  const a = Number(v1);
  const b = Number(v2);
  switch (operator) {
    case "between":
      return Number.isFinite(a) && Number.isFinite(b) && amount >= a && amount <= b;
    case "under":
      return Number.isFinite(a) && amount < a;
    case "over":
      return Number.isFinite(a) && amount > a;
    case "equal":
      return Number.isFinite(a) && amount === a;
    default:
      return true;
  }
}

// Match operator against a set of candidate values (requester/supplier/
// customer). Empty rule value behaves like "any".
function textAny(
  operator: Rule["operator"],
  candidates: (string | null)[],
  value: string
): boolean {
  if (operator === "any" || !value) return true;
  const needle = value.toLowerCase();
  const hit = candidates.some(
    (c) => c != null && c.trim().toLowerCase() === needle
  );
  return operator === "not_matches" ? !hit : hit;
}

// Same, but a match on ANY line item counts ("Category matches" = any line
// in that category).
function lineAny(
  operator: Rule["operator"],
  candidates: (string | null)[],
  value: string
): boolean {
  return textAny(operator, candidates, value);
}
