"use client";

import { useEffect, useState } from "react";
import { StepApproverMatrixRow, type RowCondition } from "@/components/StepApproverMatrixRow";
import type { TagOption } from "@/components/TagInput";

export interface StepApproverData {
  id: string;
  approver_user_id: string;
  is_default: boolean;
  conditions: RowCondition[];
}

// Trigger button + ApprovalMax-style "Approval matrix for the step ..."
// modal: approvers as rows, Class/Category/Supplier/Customer conditions as
// columns.
// Authored by Araza.
export function StepApproversManager({
  stepName,
  approvers,
  approverOptions,
  projectOptions,
  classOptions,
  categoryOptions,
  supplierOptions,
  saveApprover,
  deleteApprover,
  readOnly,
}: {
  stepName: string;
  approvers: StepApproverData[];
  approverOptions: { id: string; label: string }[];
  projectOptions: TagOption[];
  // QBO mirrors (read-only) for the matrix cells — searchable pick-lists
  // so approvers choose from the real lists rather than free-typing.
  classOptions?: TagOption[];
  categoryOptions?: TagOption[];
  supplierOptions?: TagOption[];
  saveApprover?: (approverRowId: string, formData: FormData) => Promise<void>;
  deleteApprover?: (approverRowId: string) => Promise<void>;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pendingNewRows, setPendingNewRows] = useState<number[]>([]);

  // A save/add that lands revalidates the page, growing `approvers` — clear
  // any unsaved blank rows once that happens so a just-saved row doesn't
  // linger duplicated as an empty "new" row underneath its real one.
  useEffect(() => {
    setPendingNewRows([]);
  }, [approvers.length]);

  const close = () => {
    setOpen(false);
    setPendingNewRows([]);
  };

  // Two ways in to close reliably regardless of how tall the matrix gets:
  // Escape, and clicking the backdrop outside the card. Previously the
  // only way out was the small × in the header, and the header scrolled
  // away with the rest of the content once there were enough approver
  // rows to make the modal taller than the viewport — reported as
  // "awkward to get out of that screen" once a step has several
  // approvers saved.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
      >
        {approvers.length === 0
          ? "Add approvers"
          : `${approvers.length} approver${approvers.length === 1 ? "" : "s"}`}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
          onClick={close}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-6xl flex-col rounded-lg bg-white shadow-elevation-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={close}
                className="text-xl leading-none text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
              <h2 className="text-base font-semibold text-slate-800">
                Approval matrix for the step &quot;{stepName}&quot;
              </h2>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {!readOnly && (
                <p className="mb-3 text-xs text-slate-400">
                  Need &quot;approve if X, OR if Y&quot; for one person? Add them
                  twice with different conditions on each row — either matching
                  makes them an approver.
                </p>
              )}
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setPendingNewRows((r) => [...r, Date.now()])}
                  className="mb-3 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  + Add an Approver
                </button>
              )}
              <div className="grid grid-cols-[160px_1fr_1fr_1fr_1fr_140px] gap-x-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Approver
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Class
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Category
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Supplier
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Customer
                </div>
                <div />

                {approvers.map((a) => (
                  <StepApproverMatrixRow
                    key={a.id}
                    approverRowId={a.id}
                    approverOptions={approverOptions}
                    projectOptions={projectOptions}
                    classOptions={classOptions}
                    categoryOptions={categoryOptions}
                    supplierOptions={supplierOptions}
                    initialApproverUserId={a.approver_user_id}
                    initialIsDefault={a.is_default}
                    initialConditions={a.conditions}
                    saveApprover={readOnly ? undefined : saveApprover}
                    deleteApprover={readOnly ? undefined : deleteApprover}
                    readOnly={readOnly}
                  />
                ))}
                {approvers.length === 0 && pendingNewRows.length === 0 && (
                  <div className="col-span-6 border-t border-slate-100 py-4 text-sm text-slate-400">
                    No approvers yet.
                  </div>
                )}
                {!readOnly &&
                  pendingNewRows.map((key) => (
                    <StepApproverMatrixRow
                      key={key}
                      approverRowId="new"
                      approverOptions={approverOptions}
                      projectOptions={projectOptions}
                      classOptions={classOptions}
                      categoryOptions={categoryOptions}
                      supplierOptions={supplierOptions}
                      initialApproverUserId=""
                      initialIsDefault={false}
                      initialConditions={[]}
                      saveApprover={saveApprover}
                      onCancelNew={() =>
                        setPendingNewRows((r) => r.filter((k) => k !== key))
                      }
                    />
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
