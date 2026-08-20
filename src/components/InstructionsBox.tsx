"use client";

import { useRef } from "react";

// Instructions for accounting (maps to the QBO bill memo / PrivateNote).
// Auto-saves when the field loses focus, so an approver can type a note
// and press Approve without a separate save. Authored by Araza.
export function InstructionsBox({
  initialValue,
  saveInstructions,
}: {
  initialValue: string;
  saveInstructions: (formData: FormData) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div>
      <p className="mt-2 text-xs text-slate-400">
        Internal guidance for your accounting team. On QBO sync this becomes
        the bill&apos;s memo (PrivateNote) — not printed on the invoice.
      </p>
      <form ref={formRef} action={saveInstructions} className="mt-2">
        <textarea
          name="instructions"
          defaultValue={initialValue}
          rows={3}
          placeholder="e.g. Allocate to job 12-45, net-30 terms, prior approval required…"
          onBlur={() => formRef.current?.requestSubmit()}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-slate-400">
            auto-saves on edit
          </span>
          <button className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
