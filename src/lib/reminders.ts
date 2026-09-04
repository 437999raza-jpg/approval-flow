import { createAdminClient } from "@/lib/supabase/admin";
import { requiredApproversFor } from "@/lib/dashboard-actions";

// Computes, for one organization, every currently-pending invoice's
// required approver(s) and how long it's sat on its current step —
// shared by the daily digest and the escalation check
// (src/app/api/cron/reminders/route.ts). Runs with the admin client:
// this is a cron job, there's no signed-in user to scope RLS to.
// Authored by Araza.

export interface PendingItem {
  invoiceId: string;
  label: string;
  stepName: string | null;
  daysOnStep: number;
  deadlineDays: number | null;
  overdue: boolean;
}

export interface EscalationCandidate {
  invoiceId: string;
  label: string;
  stepName: string | null;
  daysOnStep: number;
  deadlineDays: number;
  approverIds: string[];
  // Who the step nominates to be told (migration 0094). Null falls back
  // to every org admin, which is what happened before this was
  // configurable. Deliberately per-step rather than derived from a
  // reporting line: the same two people appear in both orders across
  // workflows, so "escalate upward" would be wrong half the time.
  escalateToUserId: string | null;
}

// "An invoice can get stuck forever with zero notification to anyone"
// — a step whose Class/Category/Supplier/Customer conditions match no
// current approver at all (a workflow misconfiguration, or the
// invoice's own fields changing after it landed there). Worse than a
// slow invoice: nothing else will ever surface this on its own, since
// it has no approver to nag or escalate FROM in the first place.
export interface NoApproverItem {
  invoiceId: string;
  label: string;
  stepName: string | null;
  // Null means never notified yet; the caller throttles re-sends
  // against this rather than a one-shot flag (unlike escalated_at) —
  // a slow invoice at least has someone who can act on it, this one
  // doesn't until a human happens to fix the workflow.
  noticeSentAt: string | null;
}

export interface OrgPending {
  byApprover: Map<string, PendingItem[]>;
  escalations: EscalationCandidate[];
  noApprover: NoApproverItem[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Fallback grace period after a step's own deadline before anyone gets
// paged — the daily digest is already nagging the approver every day
// past the deadline; escalation is for when that alone hasn't worked.
// Orgs set their own via organizations.escalation_grace_days (migration
// 0094); this is only used if that read fails.
const DEFAULT_ESCALATION_GRACE_DAYS = 2;

export async function computeOrgPending(organizationId: string): Promise<OrgPending> {
  const admin = createAdminClient();
  const byApprover = new Map<string, PendingItem[]>();
  const escalations: EscalationCandidate[] = [];
  const noApprover: NoApproverItem[] = [];

  const { data: orgRow } = await admin
    .from("organizations")
    .select("escalation_grace_days")
    .eq("id", organizationId)
    .single();
  const graceDays = orgRow?.escalation_grace_days ?? DEFAULT_ESCALATION_GRACE_DAYS;

  const { data: invoicesRaw } = await admin
    .from("invoices")
    .select(
      "id, vendor_name, invoice_number, file_name, workflow_id, current_step_order, current_step_entered_at, step_override_approver_id, project_id, escalated_at, no_approver_notice_sent_at"
    )
    .eq("organization_id", organizationId)
    .eq("status", "on_approval");
  const invoices = invoicesRaw ?? [];
  if (invoices.length === 0) return { byApprover, escalations, noApprover };

  const workflowIds = [
    ...new Set(invoices.map((i) => i.workflow_id).filter((v): v is string => !!v)),
  ];
  const { data: stepsRaw } =
    workflowIds.length > 0
      ? await admin.from("approval_workflow_steps").select("*").in("workflow_id", workflowIds)
      : { data: [] };
  const stepByKey = new Map((stepsRaw ?? []).map((s) => [`${s.workflow_id}:${s.step_order}`, s]));

  const now = Date.now();

  for (const inv of invoices) {
    if (!inv.workflow_id) continue;
    const step = stepByKey.get(`${inv.workflow_id}:${inv.current_step_order}`);
    if (!step) continue;

    const approverIds = await requiredApproversFor(admin, step, {
      id: inv.id,
      organization_id: organizationId,
      vendor_name: inv.vendor_name,
      project_id: inv.project_id,
      step_override_approver_id: inv.step_override_approver_id,
    });
    const label = `${inv.vendor_name ?? inv.file_name}${
      inv.invoice_number ? ` #${inv.invoice_number}` : ""
    }`;

    if (approverIds.length === 0) {
      noApprover.push({
        invoiceId: inv.id,
        label,
        stepName: step.name || null,
        noticeSentAt: inv.no_approver_notice_sent_at,
      });
      continue;
    }

    const enteredAt = new Date(inv.current_step_entered_at).getTime();
    const daysOnStep = Math.floor((now - enteredAt) / DAY_MS);
    const deadlineDays = step.deadline_days;
    const overdue = deadlineDays != null && daysOnStep >= deadlineDays;

    const item: PendingItem = {
      invoiceId: inv.id,
      label,
      stepName: step.name || null,
      daysOnStep,
      deadlineDays,
      overdue,
    };
    for (const uid of approverIds) {
      const list = byApprover.get(uid) ?? [];
      list.push(item);
      byApprover.set(uid, list);
    }

    if (deadlineDays != null && daysOnStep >= deadlineDays + graceDays && !inv.escalated_at) {
      escalations.push({
        invoiceId: inv.id,
        label,
        stepName: step.name || null,
        daysOnStep,
        deadlineDays,
        approverIds,
        escalateToUserId: step.escalate_to_user_id,
      });
    }
  }

  return { byApprover, escalations, noApprover };
}
