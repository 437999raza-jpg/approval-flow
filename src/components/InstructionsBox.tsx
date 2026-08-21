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

  // Full-height flex column, action row anchored to the bottom via
  // justify-end so the Approve button lands on the same baseline as the
  // Hold/Reject/Cancel row beside it, whatever height the two columns are
  // stretched to. The fixed gap-3 between the textarea and the button is a
  // real reserved gap, not slack space — it holds even when this column
  // ends up exactly as tall as its content (no free space to distribute),
  // which is what left the two touching before. border-transparent keeps
  // every button here exactly as tall as the bordered ones opposite.
  return (
    <div className="flex h-full flex-col">
      <p className="mt-2 text-xs text-slate-400">
        Internal guidance for your accounting team. On QBO sync this becomes
        the bill&apos;s memo (PrivateNote) — not printed on the invoice.
      </p>
      <form
        ref={formRef}
        action={approve ?? saveInstructions}
        className="mt-2 flex flex-1 flex-col justify-end gap-3"
      >
        <textarea
          name="instructions"
          defaultValue={initialValue}
          rows={2}
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
          <button className="w-full rounded-md border border-transparent bg-emerald-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-emerald-700">
            Approve
          </button>
        ) : readOnly ? null : (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400">
              auto-saves on edit
            </span>
            <button className="rounded-md border border-transparent bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700">
              Save
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
