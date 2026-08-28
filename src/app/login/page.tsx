"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";

// Two ways in, one form visible at a time: password is the default (the
// common path for a returning user), one-time email link is a fallback
// reachable via a single toggle — also doubles as "forgot password" since
// there's no separate reset flow, it just signs you in without one.
type Mode = "password" | "magic";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // These are plain client-side onSubmit handlers (direct Supabase auth
  // calls), not server actions, so useFormStatus doesn't apply here —
  // tracked by hand instead, same as everywhere else in the app.
  const [magicLinkPending, setMagicLinkPending] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const pending = magicLinkPending || passwordPending;

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMagicLinkPending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
        },
      });
      if (error) setError(error.message);
      else setSent(true);
    } finally {
      setMagicLinkPending(false);
    }
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPasswordPending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } finally {
      setPasswordPending(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  const inputCls =
    "w-full rounded-lg border border-brand-line bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30";
  const labelCls = "mb-1.5 block text-xs font-medium text-brand-navy";
  const primaryBtnCls = (isPending: boolean) =>
    `flex w-full items-center justify-center gap-2 rounded-lg bg-brand-green px-4 py-2.5 text-sm font-display font-bold text-white transition-colors hover:bg-brand-green-dark disabled:cursor-not-allowed disabled:opacity-60 ${
      isPending ? "opacity-70" : ""
    }`;

  function Spinner() {
    return (
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-mist px-4 py-12">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-brand-line bg-white shadow-sm shadow-brand-ink/5 md:grid-cols-2">
        {/* Hero panel — hidden on narrow screens, the form alone still
            carries the wordmark below. */}
        <div className="relative hidden flex-col justify-between bg-gradient-to-br from-brand-ink to-brand-navy p-10 text-white md:flex">
          <Image
            src="/brand/ufirst-wordmark-white.png"
            alt="ufirst"
            width={2400}
            height={878}
            className="h-7 w-auto"
            priority
          />
          <div>
            <h1 className="font-display text-[27px] font-extrabold italic leading-tight">
              Don&apos;t hire a bookkeeper.
              <br />
              Get a whole finance <span className="text-brand-green-light">team.</span>
            </h1>
            <p className="mt-4 text-[13.5px] leading-relaxed text-[#C4D0DE]">
              <span className="font-semibold text-white">40–60% less</span> than a
              part-time hire · up and running in days · books that never stop
              for vacations
            </p>
          </div>
          <div className="brand-rule absolute bottom-0 left-0 right-0" />
        </div>

        <div className="flex flex-col justify-center p-8 sm:p-10">
          <div className="mb-7 flex flex-col items-start">
            <Image
              src="/brand/ufirst-wordmark.png"
              alt="ufirst"
              width={2400}
              height={878}
              className="h-6 w-auto"
              priority
            />
            <p className="mt-3 text-sm text-brand-muted">
              Sign in to review and approve invoices
            </p>
          </div>

          <div>
            {mode === "magic" && sent ? (
            <div className="py-2 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-brand-mist text-brand-green-dark">
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                  <path
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="mt-3 text-sm font-medium text-slate-800">
                Check your email
              </p>
              <p className="mt-1 text-sm text-slate-500">
                We sent a sign-in link to <span className="font-medium text-slate-700">{email}</span>.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSent(false);
                  switchMode("password");
                }}
                className="mt-5 text-sm font-medium text-brand-green-dark hover:underline"
              >
                ← Back to sign in
              </button>
            </div>
          ) : mode === "magic" ? (
            <form onSubmit={sendMagicLink} className="space-y-4">
              <div>
                <label className={labelCls}>Email</label>
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                />
              </div>
              <button type="submit" disabled={pending} className={primaryBtnCls(magicLinkPending)}>
                {magicLinkPending && <Spinner />}
                {magicLinkPending ? "Sending…" : "Send one-time link"}
              </button>
              <button
                type="button"
                onClick={() => switchMode("password")}
                className="block w-full text-center text-sm font-medium text-slate-500 hover:text-slate-700"
              >
                ← Sign in with password instead
              </button>
            </form>
          ) : (
            <form onSubmit={signInWithPassword} className="space-y-4">
              <div>
                <label className={labelCls}>Email</label>
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className={labelCls + " mb-0"}>Password</label>
                  <button
                    type="button"
                    onClick={() => switchMode("magic")}
                    className="text-xs font-medium text-brand-green-dark hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />
              </div>
              <button type="submit" disabled={pending} className={primaryBtnCls(passwordPending)}>
                {passwordPending && <Spinner />}
                {passwordPending ? "Signing in…" : "Sign in"}
              </button>
              <div className="relative py-1 text-center">
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-slate-200" />
                <span className="relative bg-white px-3 text-xs text-slate-400">or</span>
              </div>
              <button
                type="button"
                onClick={() => switchMode("magic")}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-slate-400">
                  <path
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Email me a one-time link
              </button>
            </form>
          )}

          {error && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
        </div>
      </div>
    </main>
  );
}
