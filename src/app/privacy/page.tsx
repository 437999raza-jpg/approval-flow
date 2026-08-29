import Link from "next/link";
import Image from "next/image";

// Public page — see terms/page.tsx for the same notes (no auth, linked
// from signup, drafted originally for Flow's actual sub-processors and
// data flows, not copied from another provider). Working draft, not a
// substitute for review by counsel.
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
          <p className="mt-1 text-sm text-brand-muted">Last updated: August 29, 2026</p>
        </div>

        <div className="space-y-6 p-8 text-sm leading-relaxed text-slate-700 sm:p-10">
          <p>
            This Privacy Policy explains how [Company Legal Name] (&quot;Flow&quot;,
            &quot;we&quot;, &quot;us&quot;) collects, uses, and protects personal data when you
            or your organization use Flow. It applies alongside our{" "}
            <Link href="/terms" className="text-brand-green-dark underline">
              Terms of Service
            </Link>
            .
          </p>

          <Section title="1. Information we collect">
            <strong>Account information</strong> — name, email address, and company name when you
            or your organization&apos;s admin creates an account. <strong>Document content</strong> —
            the invoices, vendor statements, and related files your organization submits for
            processing, including any vendor, financial, or contact details they contain.{" "}
            <strong>Usage data</strong> — log and activity data (such as sign-ins, documents
            processed, and feature usage) needed to operate and improve the service. If you
            connect QuickBooks Online, we also access the accounting data you authorize.
          </Section>

          <Section title="2. How we use this information">
            To provide the service — routing invoices through your approval workflow, extracting
            document data, syncing to QuickBooks Online when connected, and billing your
            organization&apos;s chosen plan; to communicate with you about your account, including
            service notices and, only if you&apos;ve opted in, product updates and offers; and to
            monitor, secure, and improve Flow.
          </Section>

          <Section title="3. Sub-processors we use">
            We rely on a small number of third-party service providers to operate Flow, each
            processing data only as needed for its function: <strong>Supabase</strong> (database
            and file storage), <strong>OpenRouter</strong> (routes documents to AI models for data
            extraction), <strong>Resend</strong> (transactional email delivery), <strong>Stripe</strong>{" "}
            (payment processing), and, where you choose to connect it,{" "}
            <strong>QuickBooks Online / Intuit</strong> (accounting sync). We may update this list
            as the service evolves; material changes will be reflected here.
          </Section>

          <Section title="4. Data retention">
            We retain your organization&apos;s data for as long as the account is active, plus a
            reasonable period afterward to allow reactivation, meet legal or accounting
            obligations, and resolve disputes. You may request deletion of your organization&apos;s
            data after account closure, subject to any retention we&apos;re required to keep by
            law.
          </Section>

          <Section title="5. Security">
            We use industry-standard safeguards — including encryption in transit, access
            controls scoped to your own organization&apos;s data, and restricted internal access —
            to protect the information you submit. No method of transmission or storage is
            perfectly secure, and we cannot guarantee absolute security.
          </Section>

          <Section title="6. International data transfers">
            Our service providers may process and store data in countries other than your own.
            Where personal data is transferred internationally, we rely on appropriate safeguards
            required by applicable law.
          </Section>

          <Section title="7. Your rights">
            Depending on your location, you may have the right to access, correct, export, or
            request deletion of your personal data, or to object to certain processing. To
            exercise these rights, contact us at [support email]; we&apos;ll respond within the
            timeframe required by applicable law. If your data was submitted to Flow by your
            employer or another organization, we may direct your request to that organization,
            since they control the account.
          </Section>

          <Section title="8. Cookies">
            We use a limited set of cookies necessary to keep you signed in and to remember basic
            preferences. We do not use third-party advertising cookies.
          </Section>

          <Section title="9. Children's privacy">
            Flow is a business tool not directed at children, and we do not knowingly collect
            personal data from anyone under 16.
          </Section>

          <Section title="10. Changes to this policy">
            We may update this Privacy Policy from time to time. For material changes, we will
            provide reasonable notice, such as an in-app notice or an email to your
            organization&apos;s admin, before the change takes effect.
          </Section>

          <Section title="11. Contact us">
            Questions about this policy, or requests relating to your personal data, can be sent
            to [support email].
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
