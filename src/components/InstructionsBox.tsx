"use client";

import { useRef, useState } from "react";
import type { BillInstructionsEntry } from "./BillPanel";

// Instructions for accounting — an append-only thread. Each approver ADDS
// their own line (nobody can change a previous one), and the whole thread
// becomes the QBO bill memo (PrivateNote) on sync, so accountants see every
// approver's note in order in QBO reports.
//
// For the approver the Add box IS the Approve button: type a note, press
// Approve — the note is appended and the invoice approved in one motion.
// The box is controlled and clears after a successful save, so a saved
// note never lingers as if it were still unsent.
// Authored by Araza.
export function InstructionsBox({
  entries,
  saveInstructions,
  approve,
  readOnly = false,
}: {
  entries: BillInstructionsEntry[];
  saveInstructions: (formData: FormData) => Promise<void>;
  approve?: (formData: FormData) => Promise<void>;
  readOnly?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [text, setText] = useState("");

  // Wraps the server action so we can clear the box once the note is saved.
  // The textarea is controlled (value=text), so its value is submitted with
  // the form; after the action resolves we reset it to empty.
  async function handleSubmit(formData: FormData) {
    const action = approve ?? saveInstructions;
    await action(formData);
    setText("");
  }

  return (
    <div className="flex h-full flex-col">
      <p className="mt-2 text-xs text-slate-400">
        Internal guidance for your accounting team. Every note here is added
        to the thread and becomes part of the bill&apos;s memo (PrivateNote)
        in QuickBooks — not printed on the invoice.
      </p>

      {/* History — everyone's notes, oldest first */}
      {entries.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {entries.map((e) => (
            <div key={e.id} className="rounded-md bg-slate-50 px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold text-slate-700">
                  {e.authorName}
                </span>
                <span className="text-[10px] text-slate-400">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-700">
                {e.body}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-400">
          No instructions yet — add the first note for accounting.
        </p>
      )}

      {/* Add your own note (append-only) */}
      <form
        ref={formRef}
        action={handleSubmit}
        className="mt-2 flex flex-1 flex-col justify-end gap-3"
      >
        {!readOnly && (
          <textarea
            name="instructions"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="Add a note for accounting (e.g. Bill to the customer, add 5% profit…)"
            onBlur={
              approve
                ? undefined // never auto-submit to Approve on blur
                : () => formRef.current?.requestSubmit()
            }
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        )}
        {approve ? (
          <button className="w-full rounded-md border border-transparent bg-emerald-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-emerald-700">
            Approve
          </button>
        ) : readOnly ? null : (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400">
              note is added to the thread
            </span>
            <button className="rounded-md border border-transparent bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700">
              Add note
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
