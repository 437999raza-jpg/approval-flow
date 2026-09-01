"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Combobox } from "@/components/Combobox";

// The vendor is read off the statement itself (extraction picks up the
// letterhead/company name and matches it to a known supplier) — no need
// to pick one before uploading. The Combobox here is only a manual
// override for the rare case extraction can't find a name at all (e.g. a
// logo with no printed company name) or gets it wrong; if left blank,
// the server resolves it from the document. Getting it wrong either way
// is correctable afterward on the statement's own page.
export function StatementUploadForm({
  suppliers,
  action,
}: {
  suppliers: { id: string; name: string }[];
  action: (formData: FormData) => Promise<{ ok: boolean; error?: string; statementId?: string }>;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [supplierOverride, setSupplierOverride] = useState("");
  const [comboboxKey, setComboboxKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearFile = () => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setFileName(null);
  };

  const submit = async () => {
    setError(null);
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a statement file to upload.");
      return;
    }
    setBusy(true);
    try {
      const formData = new FormData();
      if (supplierOverride) formData.set("supplier_name", supplierOverride);
      formData.set("file", file);
      const res = await action(formData);
      if (res.ok && res.statementId) {
        router.push(`/statements/${res.statementId}`);
      } else {
        setError(res.error ?? "Could not reconcile the statement.");
      }
    } finally {
      setBusy(false);
      clearFile();
      setSupplierOverride("");
      setComboboxKey((k) => k + 1);
    }
  };

  return (
    <div className="rounded-lg border border-brand-line bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
            Statement file
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              className="block flex-1 text-sm text-brand-ink file:mr-2 file:rounded-md file:border-0 file:bg-brand-mist file:px-2 file:py-1.5 file:text-xs file:font-medium"
            />
            {fileName && (
              <button
                type="button"
                onClick={clearFile}
                title="Clear file"
                className="flex-none rounded-md border border-brand-line px-2 py-1 text-xs text-brand-muted hover:bg-brand-mist"
              >
                ✕
              </button>
            )}
          </div>
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
      <div className="mt-3 max-w-xs">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          Vendor (optional — only if the statement doesn&apos;t show one clearly)
        </label>
        <Combobox
          key={comboboxKey}
          formId="_statement_upload"
          name="_supplier_name"
          options={suppliers.map((s) => s.name)}
          defaultValue=""
          placeholder="Auto-detected from the statement"
          className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
          onCommit={(value) => setSupplierOverride(value)}
        />
      </div>
      {error && <p className="mt-2 text-xs text-amber-700">{error}</p>}
    </div>
  );
}
