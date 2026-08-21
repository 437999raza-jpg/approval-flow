import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import {
  effectiveApproversForStep,
  type StepApprover,
  type StepCondition,
} from "@/lib/workflow-conditions";

// Unlike ApprovalMax, Approval Flow never snapshots a workflow onto a bill
// — effectiveApproversForStep() is recomputed live from the current
// workflow definition every time, so editing a step's approvers/conditions
// takes effect on every in-flight invoice at that step immediately, with
// no "restart the workflow" step (which in ApprovalMax resets the audit
// trail — explicitly not wanted here, see the Reassign-to admin override
// instead). This module computes the blast radius of such an edit so it's
// visible rather than silent: for every on_approval/on_hold invoice
// currently sitting at the edited step, did its required-approver set
// change between the old and new approver/condition state? Authored by
// Araza.

export interface StepApproverSnapshot {
  approvers: StepApprover[];
  conditions: StepCondition[];
}

// Current approvers + their conditions for one step — call before and
// after mutating to get the "before"/"after" snapshots recordStepChangeImpact
// diffs against.
export async function fetchStepApproverSnapshot(
  supabase: SupabaseClient<Database>,
  stepId: string
): Promise<StepApproverSnapshot> {
  const { data: approversRaw } = await supabase
    .from("approval_workflow_step_approvers")
    .select("*")
    .eq("step_id", stepId);
  const approvers: StepApprover[] = (approversRaw ?? []).map((a) => ({
    id: a.id,
    approver_user_id: a.approver_user_id,
    is_default: a.is_default,
  }));

  const approverIds = approvers.map((a) => a.id);
  const { data: conditionsRaw } =
    approverIds.length > 0
      ? await supabase
          .from("approval_workflow_step_conditions")
          .select("*")
          .in("step_approver_id", approverIds)
      : { data: [] };
  const conditions: StepCondition[] = (conditionsRaw ?? []).map((c) => ({
    step_approver_id: c.step_approver_id,
    field: c.field,
    operator: c.operator,
    match_values: c.match_values,
  }));

  return { approvers, conditions };
}

interface ImpactedInvoice {
  invoice_id: string;
  invoice_label: string;
  before: string[];
  after: string[];
}

export async function recordStepChangeImpact(
  supabase: SupabaseClient<Database>,
  args: {
    organizationId: string;
    workflowId: string;
    stepId: string;
    stepOrder: number;
    stepLabel: string;
    actorId: string;
    summary: string;
    before: StepApproverSnapshot;
    after: StepApproverSnapshot;
  }
): Promise<void> {
  const { organizationId, workflowId, stepId, stepOrder, actorId, summary, before, after } =
    args;

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, invoice_number, vendor_name, project_id")
    .eq("workflow_id", workflowId)
    .eq("current_step_order", stepOrder)
    .in("status", ["on_approval", "on_hold"]);
  if (!invoices || invoices.length === 0) return;

  const invoiceIds = invoices.map((i) => i.id);
  const { data: lineItemRows } = await supabase
    .from("invoice_line_items")
    .select("invoice_id, class, category, project_id")
    .in("invoice_id", invoiceIds);
  const lineItemsByInvoice = new Map<
    string,
    { class: string | null; category: string | null; project_id: string | null }[]
  >();
  for (const row of lineItemRows ?? []) {
    const list = lineItemsByInvoice.get(row.invoice_id) ?? [];
    list.push({ class: row.class, category: row.category, project_id: row.project_id });
    lineItemsByInvoice.set(row.invoice_id, list);
  }

  const allApproverIds = [
    ...new Set([
      ...before.approvers.map((a) => a.approver_user_id),
      ...after.approvers.map((a) => a.approver_user_id),
    ]),
  ];
  const { data: approverProfiles } =
    allApproverIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", allApproverIds)
      : { data: [] };
  const nameById = new Map(
    (approverProfiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
  );

  const impacted: ImpactedInvoice[] = [];
  for (const invoice of invoices) {
    const lineItems = lineItemsByInvoice.get(invoice.id) ?? [];
    const invoiceForMatching = { vendor_name: invoice.vendor_name, project_id: invoice.project_id };

    const beforeIds = effectiveApproversForStep(
      before.approvers,
      before.conditions,
      invoiceForMatching,
      lineItems
    );
    const afterIds = effectiveApproversForStep(
      after.approvers,
      after.conditions,
      invoiceForMatching,
      lineItems
    );

    const beforeSet = new Set(beforeIds);
    const afterSet = new Set(afterIds);
    const changed =
      beforeSet.size !== afterSet.size || [...beforeSet].some((id) => !afterSet.has(id));
    if (!changed) continue;

    impacted.push({
      invoice_id: invoice.id,
      invoice_label: `${invoice.vendor_name ?? "Unknown vendor"}${
        invoice.invoice_number ? ` #${invoice.invoice_number}` : ""
      }`,
      before: beforeIds.map((id) => nameById.get(id) ?? "Unknown"),
      after: afterIds.map((id) => nameById.get(id) ?? "Unknown"),
    });
  }

  if (impacted.length === 0) return;

  await supabase.from("workflow_change_impacts").insert({
    organization_id: organizationId,
    workflow_id: workflowId,
    step_id: stepId,
    actor_id: actorId,
    summary,
    affected: impacted,
  });
}
