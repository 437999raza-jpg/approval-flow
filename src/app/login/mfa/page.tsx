"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";

// Sign-in-time second step for anyone with a verified TOTP factor —
// middleware.ts redirects here whenever a session's AAL is aal1 but the
// account requires aal2. Not reachable (redirected past) once the
// challenge succeeds, since the session's AAL then matches. Authored by
// Araza.
export default function MfaChallengePage() {
  // useSearchParams() requires a Suspense boundary in the App Router —
  // the inner component is the one that actually calls it.
  return (
    <Suspense fallback={null}>
      <MfaChallengeInner />
    </Suspense>
  );
}

function MfaChallengeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/dashboard";

  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/login");
        return;
      }
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp.find((f) => f.status === "verified");
      if (listError || !verified) {
        // Nothing to challenge against — shouldn't normally happen (the
        // middleware only sends us here when aal2 is actually required),
        // but fail safe rather than trap someone on a dead-end screen.
        router.replace(next);
        return;
      }
      setFactorId(verified.id);
      setLoading(false);
    })();
  }, [router, next]);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
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
      router.push(next);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const signOutInstead = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-mist px-4 py-12">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-brand-line bg-white p-8 shadow-sm shadow-brand-ink/5">
        <Image
          src="/brand/ufirst-wordmark.png"
          alt="ufirst"
          width={2400}
          height={878}
          className="h-6 w-auto"
          priority
        />
        <h1 className="mt-6 font-display text-lg font-extrabold text-brand-ink">
          Enter your authentication code
        </h1>
        <p className="mt-1 text-sm text-brand-muted">
          Open your authenticator app and enter the current 6-digit code.
        </p>

        {loading ? (
          <p className="mt-4 text-sm text-brand-muted">Checking…</p>
        ) : (
          <form onSubmit={verify} className="mt-4 space-y-3">
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border border-brand-line bg-white px-3.5 py-2.5 text-center text-lg tracking-[0.3em] text-slate-900 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30"
            />
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <button
              type="submit"
              disabled={busy || code.trim().length < 6}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-green px-4 py-2.5 text-sm font-display font-bold text-white transition-colors hover:bg-brand-green-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              onClick={signOutInstead}
              className="w-full text-center text-sm text-brand-muted hover:underline"
            >
              Sign out instead
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
