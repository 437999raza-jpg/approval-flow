"use client";

import { useState } from "react";

// A pre-filled, editable email the admin reviews before it actually
// sends — not a bare mailto:, not auto-sent. Mirrors the review-then-send
// shape already used for emailInvoicesAction's recipient/note fields.
export function StatementEmailDraft({
  defaultTo,
  defaultSubject,
  defaultBody,
  action,
}: {
  defaultTo: string;
  defaultSubject: string;
  defaultBody: string;
  action: (
    to: string,
    subject: string,
    body: string
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await action(to, subject, body);
      if (res.ok) {
        setSent(true);
      } else {
        setError(res.error ?? "Could not send the email.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
        Sent to {to}.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-brand-line bg-white p-4">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
        To
      </label>
      <input
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="vendor@example.com"
        className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
      />
      <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
        Subject
      </label>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
      />
      <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
        Message
      </label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        className="mt-1 w-full rounded-md border border-brand-line px-2 py-1.5 text-sm"
      />
      {error && <p className="mt-2 text-xs text-amber-700">{error}</p>}
      <button
        type="button"
        onClick={send}
        disabled={busy || !to.trim()}
        className="mt-3 rounded-md bg-brand-green px-4 py-2 text-sm font-display font-bold text-white hover:bg-brand-green-dark disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
