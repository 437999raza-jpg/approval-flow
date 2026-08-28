"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";

// Sign in has two ways in, one form visible at a time: password is the
// default (the common path for a returning user), one-time email link is a
// fallback reachable via a single toggle — also doubles as "forgot
// password" since there's no separate reset flow, it just signs you in
// without one. Sign up is a separate top-level mode (new account, own new
// organization — see ensureOrgForNewUser) rather than a third sub-mode
// here, since it needs its own fields (name) and its own "check your
// email" state distinct from the magic-link one.
type AuthMode = "signin" | "signup";
type SignInMode = "password" | "magic";

export default function LoginPage() {
  const router = useRouter();
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [signInMode, setSignInMode] = useState<SignInMode>("password");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [signupSent, setSignupSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // These are plain client-side onSubmit handlers (direct Supabase auth
  // calls), not server actions, so useFormStatus doesn't apply here —
  // tracked by hand instead, same as everywhere else in the app.
  const [magicLinkPending, setMagicLinkPending] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [signupPending, setSignupPending] = useState(false);
  const [googlePending, setGooglePending] = useState(false);
  const pending = magicLinkPending || passwordPending || signupPending || googlePending;

  async function continueWithGoogle() {
    setError(null);
    setGooglePending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
        },
      });
      // On success the browser navigates to Google immediately — nothing
      // more to do here. Only a synchronous error (e.g. Google not
      // configured as a provider yet) comes back to this branch.
      if (error) {
        setError(error.message);
        setGooglePending(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start Google sign-in.");
      setGooglePending(false);
    }
  }

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

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSignupPending(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/confirm?next=/dashboard`,
          data: { full_name: fullName.trim() || undefined },
        },
      });
      if (error) {
        setError(error.message);
        return;
      }
      if (data.session) {
        // Email confirmation is off for this project — signUp already
        // returned a live session, so there's no email to wait for.
        router.push("/dashboard");
        router.refresh();
      } else {
        setSignupSent(true);
      }
    } finally {
      setSignupPending(false);
    }
  }

  function switchSignInMode(next: SignInMode) {
    setSignInMode(next);
    setError(null);
  }

  function switchAuthMode(next: AuthMode) {
    setAuthMode(next);
    setSignInMode("password");
    setSent(false);
    setSignupSent(false);
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

  function GoogleIcon() {
    return (
      <svg viewBox="0 0 48 48" className="h-4 w-4">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.5 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.3-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.5 5.1 29.6 3 24 3c-7.4 0-13.8 4.1-17.1 10.1z" />
        <path fill="#4CAF50" d="M24 45c5.5 0 10.4-2.1 14.1-5.5l-6.6-5.4c-2 1.5-4.6 2.4-7.5 2.4-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.9 40.5 16.4 45 24 45z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.6 5.4C41.6 35.6 45 30.4 45 24c0-1.2-.1-2.3-.4-3.5z" />
      </svg>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-mist px-4 py-12">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-brand-line bg-white shadow-sm shadow-brand-ink/5 md:grid-cols-2">
        {/* Hero panel — hidden on narrow screens, the form alone still
            carries the wordmark below. */}
        <div className="relative hidden flex-col bg-gradient-to-br from-brand-ink to-brand-navy p-10 text-white md:flex">
          <h1 className="font-display text-[27px] font-extrabold italic leading-tight">
            No more chasing down who approves what.
            <br />
            Flow already knows — <span className="text-brand-green-light">automatically.</span>
          </h1>
          <ul className="mt-6 space-y-3 text-[13.5px] leading-relaxed text-[#C4D0DE]">
            {[
              "Routes each bill to the right approver by project, class, or supplier — no manual reassigning.",
              "Reads every invoice automatically — vendor, line items, totals — no manual data entry.",
              "Flags anything sitting past its deadline, with reminders and escalation so nothing goes quiet.",
              "Every approval, rejection, and comment logged automatically — a clean audit trail, always.",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="mt-0.5 h-4 w-4 flex-none text-brand-green-light"
                >
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{line}</span>
              </li>
            ))}
          </ul>
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
              {authMode === "signup"
                ? "Create your account"
                : "Sign in to review and approve invoices"}
            </p>
          </div>

          <div>
            {authMode === "signup" && signupSent ? (
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
                <p className="mt-3 text-sm font-medium text-slate-800">Confirm your email</p>
                <p className="mt-1 text-sm text-slate-500">
                  We sent a confirmation link to{" "}
                  <span className="font-medium text-slate-700">{email}</span>. Click it to
                  finish creating your account.
                </p>
                <button
                  type="button"
                  onClick={() => switchAuthMode("signin")}
                  className="mt-5 text-sm font-medium text-brand-green-dark hover:underline"
                >
                  ← Back to sign in
                </button>
              </div>
            ) : signInMode === "magic" && sent ? (
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
                <p className="mt-3 text-sm font-medium text-slate-800">Check your email</p>
                <p className="mt-1 text-sm text-slate-500">
                  We sent a sign-in link to <span className="font-medium text-slate-700">{email}</span>.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSent(false);
                    switchSignInMode("password");
                  }}
                  className="mt-5 text-sm font-medium text-brand-green-dark hover:underline"
                >
                  ← Back to sign in
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={continueWithGoogle}
                  disabled={pending}
                  className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-brand-line px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-brand-mist disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {googlePending ? <Spinner /> : <GoogleIcon />}
                  Continue with Google
                </button>
                <div className="relative py-4 text-center">
                  <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-slate-200" />
                  <span className="relative bg-white px-3 text-xs text-slate-400">or</span>
                </div>

                {authMode === "signup" ? (
                  <form onSubmit={signUp} className="space-y-4">
                    <div>
                      <label className={labelCls}>Full name</label>
                      <input
                        type="text"
                        required
                        autoFocus
                        placeholder="Jane Smith"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Email</label>
                      <input
                        type="email"
                        required
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Password</label>
                      <input
                        type="password"
                        required
                        minLength={6}
                        placeholder="At least 6 characters"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <button type="submit" disabled={pending} className={primaryBtnCls(signupPending)}>
                      {signupPending && <Spinner />}
                      {signupPending ? "Creating account…" : "Create account"}
                    </button>
                  </form>
                ) : signInMode === "magic" ? (
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
                      onClick={() => switchSignInMode("password")}
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
                          onClick={() => switchSignInMode("magic")}
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
                    <button
                      type="button"
                      onClick={() => switchSignInMode("magic")}
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
              </>
            )}

            {error && (
              <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            {!signupSent && !(signInMode === "magic" && sent) && (
              <p className="mt-6 text-center text-sm text-brand-muted">
                {authMode === "signup" ? (
                  <>
                    Already have an account?{" "}
                    <button
                      type="button"
                      onClick={() => switchAuthMode("signin")}
                      className="font-medium text-brand-green-dark hover:underline"
                    >
                      Sign in
                    </button>
                  </>
                ) : (
                  <>
                    Don&apos;t have an account?{" "}
                    <button
                      type="button"
                      onClick={() => switchAuthMode("signup")}
                      className="font-medium text-brand-green-dark hover:underline"
                    >
                      Sign up
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
