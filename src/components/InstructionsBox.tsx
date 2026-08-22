"use client";

import { useRef, useState } from "react";
import type { BillInstructionsEntry } from "./BillPanel";
import { SubmitButton } from "./SubmitButton";

// Instructions for accounting — an append-only thread. Each approver ADDS
// their own line (nobody can change a previous one), and the whole thread
// becomes the QBO bill memo (PrivateNote) on sync, so accountants see every
// approver's note in order in QBO reports.
//
// For the approver the Add box IS the Approve button: type a note, press
// Approve — the note is appended and the invoice approved in one motion.
//
// CO/Extras flag: when the approver says the invoice has COs or Extras, a
// note is REQUIRED before approving, and the line items are classed
// "Extras" on approval. The box clears after a successful save.
// Authored by Araza.
export function InstructionsBox({
  entries,
  saveInstructions,
  approve,
  readOnly = false,
  hasCosOrExtras = false,
}: {
  entries: BillInstructionsEntry[];
  saveInstructions: (formData: FormData) => Promise<void>;
  approve?: (formData: FormData) => Promise<void>;
  readOnly?: boolean;
  // True once any approver upstream has flagged the bill as having COs/
  // Extras — from then on the box is checked and LOCKED.
  hasCosOrExtras?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const formId = "instructions-form";
  const [text, setText] = useState("");
  const [localCos, setLocalCos] = useState(false);
  // Every note ever added used to render in full, permanently pushing the
  // actual bill (vendor/amount/etc.) further down the panel with each new
  // note — on a bill with a handful of notes this box alone ran ~200px
  // tall. Only the latest note shows by default; the rest are one click
  // away. The full thread still composes into the QBO memo regardless of
  // this UI state — nothing here changes what actually gets sent.
  const [showAllNotes, setShowAllNotes] = useState(false);
  const visibleEntries = showAllNotes ? entries : entries.slice(-1);
  const hiddenCount = entries.length - visibleEntries.length;

  // Locked once set upstream; otherwise the current approver can tick it.
  const cos = hasCosOrExtras || localCos;
  const cosLocked = hasCosOrExtras;

  // Wraps the server action so we can clear the box once the note is saved.
  // The textarea is controlled (value=text), so its value is submitted with
  // the form; after the action resolves we reset it to empty.
  async function handleSubmit(formData: FormData) {
    const action = approve ?? saveInstructions;
    await action(formData);
    setText("");
  }

  // With the CO/Extras flag on, approval requires a note.
  const requiresNote = cos && !!approve;

  return (
    <div className="flex h-full flex-col">
      {/* CO/Extras flag — only for APPROVERS (not the reviewer, who just
          clears review). Once set upstream it's checked and locked. */}
      {approve && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="has_cos_or_extras"
            form={formId}
            checked={cos}
            onChange={(e) => setLocalCos(e.target.checked)}
            disabled={readOnly || cosLocked}
            className="h-4 w-4 rounded border-slate-300"
          />
          {cosLocked ? (
            <span>
              Has COs or Extras{" "}
              <span className="text-[10px] font-medium text-slate-400">
                (set by an earlier approver — locked)
              </span>
            </span>
          ) : (
            "Does this invoice have COs or Extras?"
          )}
        </label>
      )}
      {requiresNote && (
        <p className="mt-1 text-xs text-red-600">
          A note for accounting is required when this invoice has COs or
          Extras — add it above to approve.
        </p>
      )}

      {/* History — everyone's notes, oldest first. Only the latest shows
          by default; older ones are a click away (see showAllNotes above).
          One toggle button, always in the same top spot, always the same
          blue styling — it used to jump from a blue link at the top
          ("Show N earlier notes") to a separate gray one at the bottom
          ("Collapse") once expanded, which read as two different controls
          instead of one toggle. */}
      {entries.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {entries.length > 1 && (
            <button
              type="button"
              onClick={() => setShowAllNotes((v) => !v)}
              className="text-[11px] font-medium text-blue-600 hover:underline"
            >
              {showAllNotes
                ? "Collapse"
                : `Show ${hiddenCount} earlier note${hiddenCount > 1 ? "s" : ""}`}
            </button>
          )}
          {visibleEntries.map((e) => (
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
        id={formId}
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
          <SubmitButton
            disabled={requiresNote && text.trim().length === 0}
            className="w-full rounded-md border border-transparent bg-emerald-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Approve
          </SubmitButton>
        ) : readOnly ? null : (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400">
              note is added to the thread
            </span>
            <SubmitButton className="rounded-md border border-transparent bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700">
              Add note
            </SubmitButton>
          </div>
        )}
      </form>
    </div>
  );
}
