"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";

// Preview before sending, because this email leaves the building.
//
// It goes to a customer's subcontractors over their name, asking for
// money — sending it blind behind a confirm() dialog was asking someone
// to trust wording they had never read. So: who it goes to, what each
// one is being asked for, the message itself, and a box for the line
// the standard wording can't know ("we're closing this out at month
// end", a name to reply to).
//
// Vendors with no address on file are listed separately rather than
// silently dropped. An address missing in QuickBooks is a five-minute
// fix, but only if someone is told about it.
// Authored by Araza.

export interface ClaimRecipient {
  supplierName: string;
  email: string | null;
  amount: number;
  bills: { invoiceNumber: string | null; date: string | null; amount: number }[];
}

export function ClaimEmailDialog({
  action,
  projectId,
  projectName,
  recipients,
  currency,
  termNoun,
  organizationName,
}: {
  action: (formData: FormData) => void | Promise<void>;
  projectId: string;
  projectName: string;
  recipients: ClaimRecipient[];
  currency: string;
  termNoun: string;
  organizationName: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  const money = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency });
  const term = termNoun.toLowerCase();

  const sendable = recipients.filter((r) => r.email);
  const missing = recipients.filter((r) => !r.email);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-brand-line bg-white px-2.5 py-1 text-xs font-medium text-brand-ink hover:bg-brand-mist"
      >
        Email for invoices
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-brand-ink/40 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`Request ${term} invoices`}
        >
          <div className="w-full max-w-2xl rounded-xl border border-brand-line bg-white shadow-elevation-3">
            <div className="flex items-start justify-between gap-4 border-b border-brand-line px-5 py-4">
              <div>
                <h3 className="font-display text-base font-extrabold text-brand-ink">
                  Ask for {term} invoices
                </h3>
                <p className="mt-0.5 text-sm text-brand-muted">
                  {projectName} — {sendable.length} email
                  {sendable.length === 1 ? "" : "s"} will be sent
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-lg px-2 py-1 text-brand-muted hover:bg-brand-mist"
              >
                ×
              </button>
            </div>

            <form action={action} className="max-h-[70vh] overflow-y-auto px-5 py-4">
              <input type="hidden" name="project_id" value={projectId} />

              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                Add a line (optional)
              </label>
              <textarea
                name="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="e.g. We're closing this job out at the end of the month — please send your invoice by the 25th."
                className="w-full rounded-lg border border-brand-line bg-white px-3 py-2 text-sm text-brand-ink placeholder:text-slate-400 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30"
              />

              {/* The message, as each vendor will read it. */}
              <div className="mt-4 rounded-lg border border-brand-line bg-brand-mist p-4 text-sm text-brand-ink">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                  Preview — {sendable[0]?.supplierName ?? "each vendor"} receives
                </p>
                <p className="mt-2">
                  <span className="text-brand-muted">Subject: </span>
                  {termNoun} release — please invoice {organizationName} ({projectName})
                </p>
                <div className="mt-3 space-y-2 border-t border-brand-line pt-3">
                  <p>Hello {sendable[0]?.supplierName ?? "[vendor]"},</p>
                  <p>
                    {projectName} is closing, and we are holding {term} from your
                    previous invoices. Please send us an invoice for the amount below
                    so we can release it.
                  </p>
                  {note.trim() && (
                    <p className="whitespace-pre-line font-medium">{note.trim()}</p>
                  )}
                  <p className="text-brand-muted">
                    [their bill list, and a total of{" "}
                    {money(sendable[0]?.amount ?? 0)}]
                  </p>
                  <p className="text-brand-muted">
                    Please add applicable taxes to your invoice — tax on {term} is
                    payable when it is released, not when it was originally withheld.
                    Reply to this email with the invoice attached and it will reach our
                    accounts payable directly.
                  </p>
                </div>
              </div>

              {/* Who gets it, and for how much. */}
              <div className="mt-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                  Recipients
                </p>
                <ul className="mt-1 divide-y divide-brand-line/60 rounded-lg border border-brand-line">
                  {sendable.map((r) => (
                    <li
                      key={r.supplierName}
                      className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="font-medium text-brand-ink">{r.supplierName}</span>{" "}
                        <span className="text-brand-muted">{r.email}</span>
                      </span>
                      <span className="tabular-nums text-brand-ink">{money(r.amount)}</span>
                    </li>
                  ))}
                  {sendable.length === 0 && (
                    <li className="px-3 py-2 text-sm text-brand-muted">
                      Nobody here has an email address on file.
                    </li>
                  )}
                </ul>
              </div>

              {missing.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <p className="font-medium">
                    {missing.length} vendor{missing.length === 1 ? "" : "s"} will be
                    skipped — no email address in QuickBooks
                  </p>
                  <p className="mt-0.5">
                    {missing.map((r) => `${r.supplierName} (${money(r.amount)})`).join(", ")}
                  </p>
                  <p className="mt-1 text-xs">
                    Add it on their vendor record in QuickBooks, run Settings → Data →
                    Sync suppliers, then send again.
                  </p>
                </div>
              )}

              <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-brand-line pt-4">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-brand-line bg-white px-3 py-1.5 text-sm font-medium text-brand-ink hover:bg-brand-mist"
                >
                  Cancel
                </button>
                <SubmitButton
                  disabled={sendable.length === 0}
                  className={`rounded-lg px-4 py-1.5 text-sm font-display font-bold ${
                    sendable.length === 0
                      ? "cursor-not-allowed bg-brand-mist text-brand-muted"
                      : "bg-brand-green text-white hover:bg-brand-green-dark"
                  }`}
                >
                  Send {sendable.length} email{sendable.length === 1 ? "" : "s"}
                </SubmitButton>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
