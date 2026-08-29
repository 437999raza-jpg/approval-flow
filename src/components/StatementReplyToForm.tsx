"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";

// Where a vendor's reply to a statement-reconciliation email should land.
// Flow always sends FROM its own verified address — this only sets
// Reply-To, so replies reach the client's own inbox. Same
// dirty-tracking/inline-error shape as InboundEmailForm.
export function StatementReplyToForm({
  currentValue,
  action,
}: {
  currentValue: string | null;
  action: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [value, setValue] = useState(currentValue ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentValue ?? "");
    setError(null);
  }, [currentValue]);

  const dirty = value.trim() !== (currentValue ?? "");

  return (
    <form
      className="mt-2 space-y-2"
      action={async (formData) => {
        setSaving(true);
        setError(null);
        const result = await action(formData);
        setSaving(false);
        if (!result.ok) setError(result.error ?? "Could not save.");
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="statement_reply_to"
          type="email"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="ap@yourcompany.com"
          className="w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!dirty || saving}
          className={clsx(
            "rounded-md px-3 py-1.5 text-xs font-medium",
            dirty && !saving
              ? "bg-slate-800 text-white hover:bg-slate-700"
              : "cursor-default bg-slate-100 text-slate-400"
          )}
        >
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <p className="text-xs text-slate-500">
        Vendor emails from Statement Reconciliation still send from Flow&apos;s address, but a
        reply goes here instead. Leave blank to have replies land on Flow&apos;s own address.
      </p>
    </form>
  );
}
