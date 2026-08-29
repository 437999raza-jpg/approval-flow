import Link from "next/link";
import Image from "next/image";

// Public page — see terms/page.tsx for the same notes (no auth, linked
// from signup, placeholder copy, matching visual shell).
export const metadata = { title: "Privacy Policy — Flow" };

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-brand-mist px-4 py-12">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-brand-line bg-white shadow-sm shadow-brand-ink/5">
        <div className="border-b border-brand-line p-8 sm:p-10">
          <Image
            src="/brand/ufirst-wordmark.png"
            alt="ufirst"
            width={2400}
            height={878}
            className="h-6 w-auto"
            priority
          />
          <h1 className="mt-6 font-display text-2xl font-extrabold text-brand-ink">
            Privacy Policy
          </h1>
          <p className="mt-1 text-sm text-brand-muted">Last updated: [date]</p>
        </div>

        <div className="space-y-6 p-8 text-sm leading-relaxed text-slate-700 sm:p-10">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            <strong>Draft placeholder.</strong> This page is a structural stand-in — the sections
            below are the ones a SaaS privacy policy typically covers, not reviewed legal text.
            Replace this content (e.g. via a service like Termly/GetTerms, or with a lawyer)
            before real customers sign up — in particular, confirm the sub-processor list below
            (Supabase, OpenRouter, Resend, Stripe, QuickBooks/Intuit) is complete and accurate.
          </div>

          <Section title="1. What we collect">
            Account information (name, email, company name), the invoices and documents you
            upload for processing, and usage data needed to operate the service.
          </Section>
          <Section title="2. How we use it">
            To provide the invoice approval and extraction service, route work to the right
            approvers, and communicate with you about your account.
          </Section>
          <Section title="3. Sub-processors">
            Flow uses third-party services to operate: Supabase (database and file storage),
            OpenRouter (document extraction), Resend (email delivery), Stripe (payment
            processing), and QuickBooks Online (accounting sync, when connected).
          </Section>
          <Section title="4. Data retention">
            Data is retained for as long as your organization&apos;s account is active, plus any
            period required by law or for legitimate business purposes after that.
          </Section>
          <Section title="5. Data sharing">
            We do not sell your data. Data is shared with the sub-processors above only as
            needed to provide the service.
          </Section>
          <Section title="6. Security">
            We use industry-standard measures (encryption in transit, access controls) to
            protect your data.
          </Section>
          <Section title="7. Your rights">
            Depending on your jurisdiction, you may have rights to access, correct, or delete
            your personal data — contact us at [support email] to exercise these rights.
          </Section>
          <Section title="8. Changes to this policy">
            We may update this policy from time to time; material changes will be communicated
            to organization admins.
          </Section>
          <Section title="9. Contact">
            Questions about this policy can be sent to [support email].
          </Section>

          <Link href="/login" className="inline-block text-sm font-medium text-brand-green-dark hover:underline">
            ← Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-sm font-bold text-brand-ink">{title}</h2>
      <p className="mt-1.5">{children}</p>
    </section>
  );
}
