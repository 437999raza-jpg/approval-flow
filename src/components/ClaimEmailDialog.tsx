"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";
import {
  CLAIM_PLACEHOLDERS,
  DEFAULT_CLAIM_SUBJECT,
  DEFAULT_CLAIM_BODY,
  fillClaimTemplate,
} from "@/lib/claim-template";

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
  supplierId: string;
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
  defaultSubject,
  defaultBody,
  sendInvoiceTo,
}: {
  action: (formData: FormData) => void | Promise<void>;
  projectId: string;
  projectName: string;
  recipients: ClaimRecipient[];
  currency: string;
  termNoun: string;
  organizationName: string;
  // The org's saved templates, or the built-in defaults.
  defaultSubject: string;
  defaultBody: string;
  sendInvoiceTo: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(defaultSubject || DEFAULT_CLAIM_SUBJECT);
  const [body, setBody] = useState(defaultBody || DEFAULT_CLAIM_BODY);
  const [emails, setEmails] = useState<Record<string, string>>(() =>
    Object.fromEntries(recipients.map((r) => [r.supplierId, r.email ?? ""]))
  );

  const money = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency });
  const term = termNoun.toLowerCase();

  // Sendable is judged on what's in the boxes now, not on what was on
  // file when the page loaded — typing an address makes that vendor
  // sendable immediately.
  const first = recipients[0];
  const preview = {
    vendor: first?.supplierName ?? "the vendor",
    project: projectName,
    amount: money(first?.amount ?? 0),
    company: organizationName,
    term,
    email: sendInvoiceTo ?? "",
  };

  const sendable = recipients.filter((r) => (emails[r.supplierId] ?? "").trim());
  const missing = recipients.filter((r) => !(emails[r.supplierId] ?? "").trim());

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

              {/* The whole email, editable. Every word of it belongs to
                  the customer — their instructions, their tone, their
                  address — so none of it is fixed in code. */}
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                Subject
              </label>
              <input
                name="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={300}
                className="w-full rounded-lg border border-brand-line bg-white px-3 py-2 text-sm text-brand-ink focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30"
              />

              <label className="mb-1 mt-3 block text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                Message
              </label>
              <textarea
                name="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                maxLength={8000}
                className="w-full rounded-lg border border-brand-line bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-brand-ink focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                {CLAIM_PLACEHOLDERS.map((ph) => (
                  <button
                    key={ph.token}
                    type="button"
                    title={ph.describes}
                    onClick={() => setBody((b) => b + ph.token)}
                    className="rounded bg-brand-mist px-1.5 py-0.5 font-mono text-[11px] text-brand-navy hover:bg-brand-line"
                  >
                    {ph.token}
                  </button>
                ))}
              </div>

              <label className="mt-3 flex items-center gap-2 text-xs text-brand-muted">
                <input
                  type="checkbox"
                  name="save_template"
                  defaultChecked
                  className="h-3.5 w-3.5 rounded border-brand-line"
                />
                Save this wording for next time
              </label>

              {/* What the first vendor will actually read. */}
              <div className="mt-4 rounded-lg border border-brand-line bg-brand-mist p-4 text-sm text-brand-ink">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                  Preview — {preview.vendor} receives
                </p>
                <p className="mt-2 font-medium">{fillClaimTemplate(subject, preview)}</p>
                <p className="mt-2 whitespace-pre-line border-t border-brand-line pt-2">
                  {fillClaimTemplate(body, preview).replace(
                    "{bills}",
                    "— their bill breakdown and total —"
                  )}
                </p>
              </div>

              {/* Who gets it, for how much, and at which address.
                  Editable inline: a missing address is a thirty-second
                  fix here, versus editing the vendor in QuickBooks and
                  re-running a supplier sync. What's typed is saved
                  against the supplier, so it's only ever typed once. */}
              <div className="mt-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                  Recipients
                </p>
                <ul className="mt-1 divide-y divide-brand-line/60 rounded-lg border border-brand-line">
                  {recipients.map((r) => (
                    <li key={r.supplierId} className="px-3 py-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium text-brand-ink">{r.supplierName}</span>
                        <span className="tabular-nums text-brand-ink">{money(r.amount)}</span>
                      </div>
                      <input
                        type="email"
                        name={`email_${r.supplierId}`}
                        value={emails[r.supplierId] ?? ""}
                        onChange={(e) =>
                          setEmails((prev) => ({ ...prev, [r.supplierId]: e.target.value }))
                        }
                        placeholder="no address on file — type one to send"
                        className={`mt-1 w-full rounded-lg border px-2.5 py-1 text-sm text-brand-ink placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-green-light/30 ${
                          (emails[r.supplierId] ?? "").trim()
                            ? "border-brand-line focus:border-brand-green"
                            : "border-amber-300 bg-amber-50"
                        }`}
                      />
                    </li>
                  ))}
                  {recipients.length === 0 && (
                    <li className="px-3 py-2 text-sm text-brand-muted">
                      Nobody on this job is still owed {term}.
                    </li>
                  )}
                </ul>
                {missing.length > 0 && (
                  <p className="mt-1.5 text-xs text-amber-700">
                    {missing.length} vendor{missing.length === 1 ? "" : "s"} still need
                    an address. Anyone left blank is skipped; what you type is saved
                    for next time.
                  </p>
                )}
              </div>

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
