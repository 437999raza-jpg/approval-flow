"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Self-service TOTP enrollment via Supabase Auth's own auth.mfa API — no
// third-party service, works with any authenticator app. Per-user opt-in,
// not admin-mandated (an admin can only see the "Enabled/Disabled" status
// already shown in the Members table below and remind someone directly).
// The actual sign-in-time challenge lives at /login/mfa, enforced by
// middleware.ts for every authenticated request. Authored by Araza.
type Step = "idle" | "enrolling" | "verifying";

export function SecurityMfaSection({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [step, setStep] = useState<Step>("idle");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
      });
      if (enrollError) {
        setError(enrollError.message);
        return;
      }
      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
      setStep("enrolling");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async () => {
    if (!factorId) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: code.trim(),
      });
      if (verifyError) {
        setError(verifyError.message);
        return;
      }
      setEnabled(true);
      setStep("idle");
      setCode("");
      setQrCode(null);
      setSecret(null);
    } finally {
      setBusy(false);
    }
  };

  const cancelEnroll = async () => {
    // An unverified factor left dangling would block re-enrolling with a
    // fresh QR code, so clean it up rather than just resetting local state.
    if (factorId) {
      const supabase = createClient();
      await supabase.auth.mfa.unenroll({ factorId }).catch(() => {});
    }
    setStep("idle");
    setFactorId(null);
    setQrCode(null);
    setSecret(null);
    setCode("");
    setError(null);
  };

  const turnOff = async () => {
    if (!window.confirm("Turn off two-factor authentication for your account?")) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { data } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp.find((f) => f.status === "verified");
      if (!verified) {
        setEnabled(false);
        return;
      }
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({
        factorId: verified.id,
      });
      if (unenrollError) {
        setError(unenrollError.message);
        return;
      }
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
      {step === "idle" && (
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm">
            <span className="font-medium text-slate-700">
              {enabled ? "Enabled" : "Not set up"}
            </span>
            <p className="mt-0.5 text-xs text-slate-500">
              {enabled
                ? "You'll be asked for a 6-digit code from your authenticator app when you sign in."
                : "Add a second step at sign-in using an authenticator app (Google Authenticator, Authy, 1Password, etc.)."}
            </p>
          </div>
          {enabled ? (
            <button
              type="button"
              onClick={turnOff}
              disabled={busy}
              className="flex-none rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ? "Turning off…" : "Turn off"}
            </button>
          ) : (
            <button
              type="button"
              onClick={startEnroll}
              disabled={busy}
              className="flex-none rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "Starting…" : "Set up two-factor authentication"}
            </button>
          )}
        </div>
      )}

      {step === "enrolling" && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Scan this with your authenticator app, then enter the 6-digit code it shows.
          </p>
          {qrCode && (
            <div
              className="h-40 w-40 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: qrCode }}
            />
          )}
          {secret && (
            <p className="text-xs text-slate-500">
              Can&apos;t scan it? Enter this key manually:{" "}
              <span className="font-mono font-semibold text-slate-700">{secret}</span>
            </p>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={confirmEnroll}
              disabled={busy || code.trim().length < 6}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify and turn on"}
            </button>
            <button
              type="button"
              onClick={cancelEnroll}
              disabled={busy}
              className="text-xs text-slate-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
