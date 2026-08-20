"use client";

import { useRef } from "react";

// Instructions for accounting (maps to the QBO bill memo / PrivateNote).
// For the approver this IS the Approve button: the note sits in the form
// and pressing Approve saves it together with the decision — the typical
// PM flow is "type a note, press Approve". For everyone else it's a plain
// auto-saving text box with a Save button.
// Authored by Araza.
export function InstructionsBox({
  initialValue,
  saveInstructions,
  approve,
  readOnly = false,
}: {
  initialValue: string;
  saveInstructions: (formData: FormData) => Promise<void>;
  approve?: (formData: FormData) => Promise<void>;
  readOnly?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div>
      <p className="mt-2 text-xs text-slate-400">
        Internal guidance for your accounting team. On QBO sync this becomes
        the bill&apos;s memo (PrivateNote) — not printed on the invoice.
      </p>
      <form
        ref={formRef}
        action={approve ?? saveInstructions}
        className="mt-2"
      >
        <textarea
          name="instructions"
          defaultValue={initialValue}
          rows={3}
          disabled={readOnly}
          placeholder="e.g. Allocate to job 12-45, net-30 terms, prior approval required…"
          onBlur={
            approve || readOnly
              ? undefined // never auto-submit to Approve on blur
              : () => formRef.current?.requestSubmit()
          }
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
        />
        {approve ? (
          <button className="mt-2 w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            Approve
          </button>
        ) : readOnly ? null : (
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-slate-400">
              auto-saves on edit
            </span>
            <button className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700">
              Save
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
