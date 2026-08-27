"use client";

import { useState } from "react";

// "Pay now" button that creates a Stripe Checkout session for the org's
// suggested usage charge and redirects to Stripe's hosted page. When Stripe
// isn't configured yet the action returns a clear error instead of the URL,
// shown inline below the button.
export function StripeCheckoutButton({
  action,
}: {
  action: () => Promise<{ ok: boolean; url?: string; error?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (res.ok && res.url) {
        window.location.href = res.url;
      } else {
        setError(res.error ?? "Could not start checkout.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={pay}
        disabled={busy}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? "Opening checkout…" : "Pay now"}
      </button>
      {error && <p className="mt-1 text-xs text-amber-700">{error}</p>}
    </div>
  );
}
