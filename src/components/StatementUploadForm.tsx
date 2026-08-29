"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Combobox } from "@/components/Combobox";

// Vendor is picked via the same Combobox used for suppliers elsewhere
// (BillPanel's vendor field) — its onCommit just stages a value in state
// here rather than submitting a real <form>, so the file input and the
// picked vendor name are combined into one FormData by hand on submit.
export function StatementUploadForm({
  suppliers,
  action,
}: {
  suppliers: { id: string; name: string }[];
  action: (formData: FormData) => Promise<{ ok: boolean; error?: string; statementId?: string }>;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [supplierName, setSupplierName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const file = fileInputRef.current?.files?.[0];
    if (!supplierName) {
      setError("Choose a vendor first.");
      return;
    }
    if (!file) {
      setError("Choose a statement file to upload.");
      return;
    }
    setBusy(true);
    try {
      const formData = new FormData();
      formData.set("supplier_name", supplierName);
      formData.set("file", file);
      const res = await action(formData);
      if (res.ok && res.statementId) {
        router.push(`/statements/${res.statementId}`);
      } else {
        setError(res.error ?? "Could not reconcile the statement.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-brand-line bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
            Vendor
          </label>
          <Combobox
            formId="_statement_upload"
            name="_supplier_name"
            options={suppliers.map((s) => s.name)}
            defaultValue=""
            placeholder="Search vendor…"
            className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
            onCommit={(value) => setSupplierName(value)}
          />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-brand-muted">
            Statement file
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            className="mt-1 block w-full text-sm text-brand-ink file:mr-2 file:rounded-md file:border-0 file:bg-brand-mist file:px-2 file:py-1.5 file:text-xs file:font-medium"
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-md bg-brand-green px-4 py-2 text-sm font-display font-bold text-white hover:bg-brand-green-dark disabled:opacity-50"
        >
          {busy ? "Reconciling…" : "Upload & reconcile"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-amber-700">{error}</p>}
    </div>
  );
}
