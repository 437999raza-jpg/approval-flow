import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { requiredApproversFor } from "@/lib/dashboard-actions";

// Who's currently required to decide each invoice's CURRENT step — reuses
// requiredApproversFor (dashboard-actions.ts) so this matches EXACTLY who'd
// see Approve/Reject on the invoice itself, not a second, possibly-
// drifting re-derivation of the same matching logic. Lives in its own
// module (not reports.ts or invoice-list-report.ts) so both of those can
// import it without creating a cycle between each other. Authored by Araza.
export type WaitingForInvoice = {
  id: string;
  vendor_name: string | null;
  project_id: string | null;
  status: string;
  workflow_id: string | null;
  current_step_order: number;
  step_override_approver_id: string | null;
};

export async function computeWaitingForIds(
  supabase: SupabaseClient<Database>,
  invoices: WaitingForInvoice[]
): Promise<Map<string, string[]>> {
  const waitingIdsByInvoice = new Map<string, string[]>();
  const workflowIds = [
    ...new Set(invoices.map((i) => i.workflow_id).filter((id): id is string => !!id)),
  ];
  const { data: stepsRaw } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_steps")
          .select("*")
          .in("workflow_id", workflowIds)
      : { data: [] };
  const stepByKey = new Map(
    (stepsRaw ?? []).map((s) => [`${s.workflow_id}:${s.step_order}`, s])
  );
  for (const inv of invoices) {
    if (
      (inv.status !== "on_approval" && inv.status !== "on_hold") ||
      !inv.workflow_id
    ) {
      continue;
    }
    const step = stepByKey.get(`${inv.workflow_id}:${inv.current_step_order}`);
    if (!step) continue;
    const ids = await requiredApproversFor(supabase, step, {
      id: inv.id,
      vendor_name: inv.vendor_name,
      project_id: inv.project_id,
      step_override_approver_id: inv.step_override_approver_id,
    });
    waitingIdsByInvoice.set(inv.id, ids);
  }
  return waitingIdsByInvoice;
}
