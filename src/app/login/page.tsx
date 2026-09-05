"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { completeSelfSignup } from "@/lib/auth-actions";
import { TurnstileWidget } from "@/components/TurnstileWidget";
import { isBusinessEmail, BUSINESS_EMAIL_MESSAGE } from "@/lib/business-email";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

// Sign in has two ways in, one form visible at a time: password is the
// default (the common path for a returning user), one-time email link is a
// fallback reachable via a single toggle — also doubles as "forgot
// password" since there's no separate reset flow, it just signs you in
// without one. Sign up is a separate top-level mode (new account, own new
// organization — see completeSelfSignup in src/lib/auth-actions.ts) rather than a third sub-mode
// here, since it needs its own fields (name) and its own "check your
// email" state distinct from the magic-link one.
type AuthMode = "signin" | "signup";
type SignInMode = "password" | "magic";
// Supabase's own provider keys — "azure" covers Microsoft/Office 365
// (Azure AD/Entra ID under the hood), "apple" covers Sign in with Apple
// (which an iCloud-email user would use).
type OAuthProvider = "google" | "azure" | "apple";

// The auth routes (/auth/callback, /auth/confirm) can only report back
// through a redirect, so they append ?error=<code>. Kept in one map so the
// wording lives next to the codes that produce it.
const REDIRECT_ERRORS: Record<string, string> = {
  business_email: BUSINESS_EMAIL_MESSAGE,
  auth_callback_failed: "That sign-in link didn't work. Please try again.",
  auth_confirm_failed: "That confirmation link has expired or was already used. Request a new one below.",
};

// The pitch, as data — the panel below renders it, the condensed mobile
// strip renders the same leads. The last one is the bespoke/custom-build
// offer, which is the actual differentiator versus the off-the-shelf tools.
const HERO_POINTS = [
  {
    lead: "Routed automatically.",
    rest: "Every bill reaches the right approver by project, class or supplier — no manual reassigning.",
  },
  {
    lead: "Read automatically.",
    rest: "Vendor, line items, totals and tax pulled off the invoice. No data entry, ever.",
  },
  {
    lead: "Chased automatically.",
    rest: "Anything past its deadline gets reminders and escalates to a manager, so nothing goes quiet.",
  },
  {
    lead: "Audited automatically.",
    rest: "Every approval, rejection and comment logged — a clean trail whenever someone asks.",
  },
  {
    lead: "Built for you.",
    rest: "Need it to match your process exactly? We build custom rules, fields and integrations to fit, for a one-time fee.",
  },
];

export default function LoginPage() {
  const router = useRouter();
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [signInMode, setSignInMode] = useState<SignInMode>("password");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
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
  const [oauthPending, setOauthPending] = useState<OAuthProvider | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const pending = magicLinkPending || passwordPending || signupPending || oauthPending !== null;

  // Surface ?error= from an auth redirect once, then strip it from the URL so
  // a refresh doesn't re-show a stale message. replaceState (not the router)
  // — nothing here needs a re-render.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (!code) return;
    setError(REDIRECT_ERRORS[code] ?? "Sign-in failed. Please try again.");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function continueWithProvider(provider: OAuthProvider) {
    setError(null);
    setOauthPending(provider);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
          // Azure doesn't return an email by default — Supabase's own
          // docs call this out as required, since the app (and
          // ensureOrgForNewUser) both key off the user's email.
          ...(provider === "azure" ? { scopes: "email" } : {}),
        },
      });
      // On success the browser navigates to the provider immediately —
      // nothing more to do here. Only a synchronous error (e.g. the
      // provider isn't configured in Supabase yet) comes back to this
      // branch.
      if (error) {
        setError(error.message);
        setOauthPending(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start sign-in.");
      setOauthPending(null);
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
    if (!isBusinessEmail(email)) {
      setError(BUSINESS_EMAIL_MESSAGE);
      return;
    }
    setSignupPending(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/confirm?next=/dashboard`,
          // company_name rides along in user_metadata specifically so
          // ensureOrgForNewUser (onboarding.ts) can read it later from
          // /auth/confirm once the emailed link is clicked — that's the
          // path that actually fires whenever confirmation is required,
          // which this Supabase project currently has ON (confirmed live:
          // signUp() here does NOT return an immediate session).
          data: {
            full_name: fullName.trim() || undefined,
            company_name: companyName.trim() || undefined,
            marketing_opt_in: marketingOptIn,
          },
          // Verified inside Supabase's own Auth server (Authentication ->
          // Settings -> CAPTCHA protection) — undefined until that's
          // configured there, in which case Supabase just skips the check
          // rather than rejecting the signup.
          captchaToken: turnstileToken || undefined,
        },
      });
      if (error) {
        setError(error.message);
        return;
      }
      if (data.session) {
        // Only reachable if this project's email confirmation is ever
        // turned off — signUp already returned a live session, so
        // there's no email to wait for. completeSelfSignup funnels
        // through the same ensureOrgForNewUser as the confirmation-link
        // path, so there's only one real implementation either way.
        const result = await completeSelfSignup(companyName);
        if (!result.ok) {
          setError(result.error ?? "Could not finish setting up your account.");
          return;
        }
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

  function MicrosoftIcon() {
    return (
      <svg viewBox="0 0 23 23" className="h-4 w-4">
        <path fill="#F35325" d="M1 1h10v10H1z" />
        <path fill="#81BC06" d="M12 1h10v10H12z" />
        <path fill="#05A6F0" d="M1 12h10v10H1z" />
        <path fill="#FFBA08" d="M12 12h10v10H12z" />
      </svg>
    );
  }

  function AppleIcon() {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
        <path d="M16.365 1.43c0 1.14-.415 2.06-1.244 2.76-.83.7-1.83 1.09-3.01 1.02-.13-1.1.36-2.14 1.15-2.86.79-.72 1.98-1.2 3.1-1.2.01.09.01.19.01.28zm3.62 15.34c-.44 1.02-.65 1.48-1.22 2.38-.79 1.26-1.9 2.83-3.29 2.85-1.23.02-1.55-.8-3.22-.79-1.67.01-2.02.8-3.25.78-1.39-.02-2.44-1.43-3.23-2.69-2.22-3.51-2.45-7.63-1.08-9.82.97-1.55 2.5-2.46 3.94-2.46 1.47 0 2.39.81 3.61.81 1.18 0 1.9-.81 3.6-.81 1.29 0 2.65.7 3.62 1.91-3.18 1.75-2.67 6.29.52 7.84z" />
      </svg>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-mist px-4 py-12">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-brand-line bg-white shadow-elevation-1 shadow-brand-ink/5 md:grid-cols-2">
        {/* Hero panel — the whole pitch, since there's no marketing site in
            front of this page yet. Deliberately no pricing: the plans live
            behind sign-in on /billing, and a number here only gives someone
            a reason to leave before they've seen what it does. Hidden on
            narrow screens, where the condensed strip below carries it. */}
        <div className="relative hidden flex-col bg-gradient-to-br from-brand-ink to-brand-navy p-10 text-white md:flex">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-brand-green-light">
            Invoice approvals, on autopilot
          </p>
          <h1 className="mt-3 font-display text-[27px] font-extrabold italic leading-tight">
            Stop chasing down who approves what.
            <br />
            Flow already knows — <span className="text-brand-green-light">automatically.</span>
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-[#C4D0DE]">
            Bills arrive, get read, and land in front of the right person the
            same minute. Nobody re-types an invoice. Nobody forwards a chase
            email.
          </p>
          <ul className="mt-6 space-y-3 text-[13.5px] leading-relaxed text-[#C4D0DE]">
            {HERO_POINTS.map(({ lead, rest }) => (
              <li key={lead} className="flex items-start gap-2.5">
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
                <span>
                  <span className="font-semibold text-white">{lead}</span> {rest}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-7 rounded-xl border border-white/10 bg-white/[0.06] p-4">
            <p className="font-display text-[13px] font-bold text-white">
              Built around your process — not the other way round.
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#C4D0DE]">
              Use it as is, or let us tailor it to your workflow with custom
              approval rules, fields, and integrations. Tell us how your
              process works, and we’ll build it—quoted upfront as a one-time
              fee in addition to your monthly plan.
            </p>
          </div>
          <p className="mt-7 text-[12px] font-medium text-[#8FA3BA]">
            14-day free trial · No credit card · Live in an afternoon
          </p>
          <div className="brand-rule absolute bottom-0 left-0 right-0" />
        </div>

        <div className="flex flex-col justify-center p-8 sm:p-10">
          <div className="mb-7 flex flex-col items-start">
            <div className="font-display text-3xl font-bold tracking-tight text-brand-green">flow</div>
            <p className="mt-3 text-sm text-brand-muted">
              {authMode === "signup"
                ? "Create your account"
                : "Sign in to review and approve invoices"}
            </p>
          </div>

          <div className="mb-6 rounded-xl border border-brand-line bg-brand-mist p-4 md:hidden">
            <p className="font-display text-[13px] font-bold leading-snug text-brand-ink">
              Stop chasing down who approves what.
            </p>
            <ul className="mt-2.5 space-y-1.5 text-[12.5px] leading-snug text-brand-muted">
              {HERO_POINTS.map(({ lead, rest }) => (
                <li key={lead}>
                  <span className="font-semibold text-brand-navy">{lead}</span> {rest}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11.5px] font-medium text-brand-green-dark">
              14-day free trial · No credit card
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
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => continueWithProvider("google")}
                    disabled={pending}
                    className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-brand-line px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-brand-mist disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {oauthPending === "google" ? <Spinner /> : <GoogleIcon />}
                    Continue with Google
                  </button>
                  <button
                    type="button"
                    onClick={() => continueWithProvider("azure")}
                    disabled={pending}
                    className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-brand-line px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-brand-mist disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {oauthPending === "azure" ? <Spinner /> : <MicrosoftIcon />}
                    Continue with Microsoft
                  </button>
                  <button
                    type="button"
                    onClick={() => continueWithProvider("apple")}
                    disabled={pending}
                    className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-brand-line px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-brand-mist disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {oauthPending === "apple" ? <Spinner /> : <AppleIcon />}
                    Continue with Apple
                  </button>
                </div>
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
                      <label className={labelCls}>Company name</label>
                      <input
                        type="text"
                        required
                        placeholder="Acme Construction"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Work email</label>
                      <input
                        type="email"
                        required
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={inputCls}
                      />
                      <p className="mt-1.5 text-[11px] text-brand-muted">
                        Your company domain — personal mailboxes (Gmail, Outlook,
                        iCloud) can&apos;t be used to create an account.
                      </p>
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
                    <label className="flex items-start gap-2 text-xs text-brand-muted">
                      <input
                        type="checkbox"
                        checked={marketingOptIn}
                        onChange={(e) => setMarketingOptIn(e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 flex-none rounded border-brand-line"
                      />
                      I agree to receive Flow&apos;s news, insights and special offers
                    </label>
                    <p className="text-xs text-brand-muted">
                      By creating an account, you agree to Flow&apos;s{" "}
                      <Link href="/terms" target="_blank" className="text-brand-green-dark underline">
                        Terms of Service
                      </Link>{" "}
                      and{" "}
                      <Link href="/privacy" target="_blank" className="text-brand-green-dark underline">
                        Privacy Policy
                      </Link>
                      .
                    </p>
                    {TURNSTILE_SITE_KEY && (
                      <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} onToken={setTurnstileToken} />
                    )}
                    <button
                      type="submit"
                      disabled={pending || (!!TURNSTILE_SITE_KEY && !turnstileToken)}
                      className={primaryBtnCls(signupPending)}
                    >
                      {signupPending && <Spinner />}
                      {signupPending ? "Creating account…" : "Start free 14-day trial"}
                    </button>
                    <p className="text-center text-[11.5px] text-brand-muted">
                      No credit card required · Cancel any time
                    </p>
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
                          tabIndex={-1}
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
