import Link from "next/link";
import Image from "next/image";

// Public page — no auth required, so a prospective signup can read this
// before creating an account (and it's linked from the signup form).
// PLACEHOLDER COPY: this is a structural draft, not reviewed legal
// text — swap in real Terms before real customers sign up. Same visual
// shell as /login (wordmark, brand-mist background, white card) so it
// reads as part of the product, not a bare unstyled page.
export const metadata = { title: "Terms of Service — Flow" };

export default function TermsPage() {
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
            Terms of Service
          </h1>
          <p className="mt-1 text-sm text-brand-muted">Last updated: [date]</p>
        </div>

        <div className="space-y-6 p-8 text-sm leading-relaxed text-slate-700 sm:p-10">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            <strong>Draft placeholder.</strong> This page is a structural stand-in — the sections
            below are the ones a SaaS terms-of-service document typically covers, not reviewed
            legal text. Replace this content (e.g. via a service like Termly/GetTerms, or with a
            lawyer) before real customers sign up.
          </div>

          <Section title="1. Acceptance of terms">
            By creating an account or using Flow, you agree to be bound by these Terms of
            Service and our <Link href="/privacy" className="text-brand-green-dark underline">Privacy Policy</Link>.
          </Section>
          <Section title="2. The service">
            Flow provides invoice approval routing, document extraction, and related workflow
            tools for organizations processing accounts-payable documents.
          </Section>
          <Section title="3. Accounts and organizations">
            Each organization is responsible for its own users, data, and configuration. Admins
            control who has access to their organization&apos;s data.
          </Section>
          <Section title="4. Subscriptions, trials, and billing">
            New organizations receive a free trial period with full access to the product. After
            the trial, continued use of certain features requires an active paid plan. Fees are
            billed as described on the Billing page and are non-refundable except as required by
            law.
          </Section>
          <Section title="5. Customer data">
            You retain ownership of the invoices, documents, and business data you upload.
            Flow processes this data solely to provide the service to you.
          </Section>
          <Section title="6. Acceptable use">
            You agree not to use Flow for unlawful purposes or to upload content you don&apos;t
            have the right to share.
          </Section>
          <Section title="7. Disclaimers and limitation of liability">
            Flow is provided &quot;as is.&quot; To the extent permitted by law, Flow is not liable
            for indirect or consequential damages arising from use of the service.
          </Section>
          <Section title="8. Termination">
            Either party may terminate the agreement as described here; upon termination, access
            to the account will end.
          </Section>
          <Section title="9. Changes to these terms">
            We may update these terms from time to time; continued use of Flow after a change
            constitutes acceptance of the updated terms.
          </Section>
          <Section title="10. Contact">
            Questions about these terms can be sent to [support email].
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
