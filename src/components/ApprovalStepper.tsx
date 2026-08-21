import { clsx } from "clsx";
import type { Database, InvoiceStatus } from "@/lib/supabase/types";

type WorkflowStep = Database["public"]["Tables"]["approval_workflow_steps"]["Row"];

interface ApprovalStepperProps {
  steps: WorkflowStep[];
  // Per step_order, whether that step's required approvers (a step can
  // have several, conditionally matched — see workflow-conditions.ts)
  // have resolved it. Computed by the caller since "who's required" is
  // per-invoice, not something this component can know on its own.
  stepStates: Map<number, "pending" | "approved" | "rejected">;
  currentStepOrder: number;
  invoiceStatus: InvoiceStatus;
}

export function ApprovalStepper({
  steps,
  stepStates,
  currentStepOrder,
  invoiceStatus,
}: ApprovalStepperProps) {
  if (steps.length === 0) return null;

  return (
    <div className="flex items-center">
      {steps.map((step, i) => {
        const decision = stepStates.get(step.step_order);
        const isCurrent = step.step_order === currentStepOrder && invoiceStatus !== "rejected";

        const state: "done" | "rejected" | "current" | "upcoming" =
          decision === "approved" || invoiceStatus === "approved"
            ? "done"
            : decision === "rejected"
              ? "rejected"
              : isCurrent
                ? "current"
                : "upcoming";

        return (
          <div key={step.id} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={clsx(
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium",
                  state === "done" && "bg-emerald-500 text-white",
                  state === "rejected" && "bg-red-500 text-white",
                  state === "current" && "bg-blue-600 text-white",
                  state === "upcoming" && "bg-slate-200 text-slate-500"
                )}
              >
                {state === "done" ? "✓" : state === "rejected" ? "✕" : step.step_order}
              </div>
              <span className="whitespace-nowrap text-xs text-slate-500">
                {step.name || `Step ${step.step_order}`}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={clsx(
                  "mx-2 h-0.5 flex-1",
                  state === "done" ? "bg-emerald-500" : "bg-slate-200"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
