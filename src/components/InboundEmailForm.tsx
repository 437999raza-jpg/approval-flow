"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";

// Friendly inbound capture address (Settings → Invoice email). Clients
// email invoices to {local}@{domain} on OUR domain — e.g.
// fluid@flow.ufirst.co — exactly like ApprovalMax/Dext: the client changes
// nothing, they just send invoices there and log in at our app.
//
// The Save button stays greyed until the local part actually differs from
// what's saved. The server action returns { ok, error } (no redirect), so
// validation problems (bad characters, address already taken) show inline;
// after a successful save the page revalidates and this component receives
// the new value as a prop, which the effect below syncs back into the input
// (the controlled-input pitfall: useState only initializes on mount).
export function InboundEmailForm({
  domain,
  currentLocal,
  currentToken,
  action,
}: {
  domain: string;
  currentLocal: string | null;
  currentToken: string;
  action: (
    formData: FormData
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [value, setValue] = useState(currentLocal ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentLocal ?? "");
    setError(null);
  }, [currentLocal]);

  const dirty = value.trim().toLowerCase() !== (currentLocal ?? "");
  const address = `${currentLocal ?? currentToken}@${domain}`;

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
      <div className="rounded-md bg-slate-50 px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Your capture address — email invoices here
        </div>
        <div className="mt-0.5 font-mono text-sm font-semibold text-slate-800">
          {address}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          name="inbound_email_local"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toLowerCase());
            setError(null);
          }}
          placeholder="friendly part, e.g. fluidconstruction"
          className="w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        <span className="text-sm text-slate-400">@{domain}</span>
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
        Your suppliers just send invoices to the address above — nothing to
        set up on their side. Leave the friendly part empty to use the token
        address instead{currentLocal ? ` (${currentToken}@${domain} still works too)` : ""}.
      </p>
    </form>
  );
}
