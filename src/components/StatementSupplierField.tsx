"use client";

import { useRef } from "react";
import { Combobox } from "@/components/Combobox";

// Correcting the vendor a statement got auto-matched to — picking a new
// one re-submits immediately (via the hidden form) and re-runs matching
// server-side (updateStatementSupplier), same autosave-on-pick pattern
// as other single-value Comboboxes in the app.
export function StatementSupplierField({
  statementId,
  supplierName,
  suppliers,
  action,
}: {
  statementId: string;
  supplierName: string;
  suppliers: { id: string; name: string }[];
  action: (statementId: string, formData: FormData) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const boundAction = action.bind(null, statementId);
  const formId = `statement-supplier-${statementId}`;

  return (
    <form ref={formRef} id={formId} action={boundAction}>
      <Combobox
        formId={formId}
        name="supplier_name"
        options={suppliers.map((s) => s.name)}
        defaultValue={supplierName}
        className="w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
        onCommit={() => formRef.current?.requestSubmit()}
      />
    </form>
  );
}
