"use client";

import { useState } from "react";

// Redirects to a Stripe-hosted page (Checkout for "Pay now", the Billing
// Portal for "Manage billing") — the action creates the session server-side
// and returns its URL. When Stripe isn't configured, or the action fails
// for any other reason, the error is shown inline rather than silently
// doing nothing.
export function StripeCheckoutButton({
  action,
  label = "Pay now",
  pendingLabel = "Opening checkout…",
  variant = "primary",
}: {
  action: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  label?: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
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
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className={
          variant === "primary"
            ? "rounded-md bg-brand-green px-4 py-2 text-sm font-display font-bold text-white hover:bg-brand-green-dark disabled:opacity-50"
            : "rounded-md border border-brand-line px-4 py-2 text-sm font-medium text-brand-navy hover:bg-brand-mist disabled:opacity-50"
        }
      >
        {busy ? pendingLabel : label}
      </button>
      {error && <p className="mt-1.5 text-xs text-amber-700">{error}</p>}
    </div>
  );
}
