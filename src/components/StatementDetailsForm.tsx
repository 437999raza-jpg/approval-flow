"use client";

import { useRef } from "react";

// Statement date / outstanding balance / note — extracted best-effort at
// upload, editable here since a misread scan or the vendor's own figure
// needs to be correctable without re-uploading. Same autosave-on-blur
// convention as the rest of the app (e.g. BillPanel's line-item fields):
// a hidden form, each field submits it on blur, no explicit Save button.
export function StatementDetailsForm({
  statementId,
  statementDate,
  statementBalance,
  note,
  action,
}: {
  statementId: string;
  statementDate: string | null;
  statementBalance: number | null;
  note: string | null;
  action: (statementId: string, formData: FormData) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const boundAction = action.bind(null, statementId);

  return (
    <form ref={formRef} action={boundAction} className="grid grid-cols-2 gap-3">
      <div>
        <label className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          Statement date
        </label>
        <input
          type="date"
          name="statement_date"
          defaultValue={statementDate ?? ""}
          onBlur={() => formRef.current?.requestSubmit()}
          className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          Outstanding balance
        </label>
        <input
          type="number"
          step="0.01"
          name="statement_balance"
          defaultValue={statementBalance ?? ""}
          onBlur={() => formRef.current?.requestSubmit()}
          className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
        />
      </div>
      <div className="col-span-2">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          Note
        </label>
        <textarea
          name="note"
          rows={2}
          defaultValue={note ?? ""}
          onBlur={() => formRef.current?.requestSubmit()}
          className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
        />
      </div>
    </form>
  );
}
