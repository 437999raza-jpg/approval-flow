import Link from "next/link";
import Image from "next/image";

// Public page — no auth required, so a prospective signup can read this
// before creating an account (and it's linked from the signup form).
// Drafted originally for Flow (not copied from any other provider's
// terms), covering the ground a workflow-automation SaaS needs to —
// bracketed [placeholders] mark the handful of facts only the business
// itself can supply (legal entity, address, governing law, contact).
// This is a working draft, not a substitute for review by counsel.
// Same visual shell as /login (wordmark, brand-mist background, white
// card) so it reads as part of the product, not a bare unstyled page.
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
          <p className="mt-1 text-sm text-brand-muted">Last updated: August 29, 2026</p>
        </div>

        <div className="space-y-6 p-8 text-sm leading-relaxed text-slate-700 sm:p-10">
          <p>
            These Terms of Service (&quot;Terms&quot;) govern access to and use of Flow, an
            invoice approval, document extraction, and accounts-payable workflow service
            (&quot;Flow&quot;, &quot;we&quot;, &quot;us&quot;) operated by UFIRST LLC, a company registered in
            Wyoming, USA (&quot;Company&quot;). By creating an account, connecting an
            organization, or otherwise using Flow, you agree to these Terms and to our{" "}
            <Link href="/privacy" className="text-brand-green-dark underline">
              Privacy Policy
            </Link>
            . If you are agreeing on behalf of an organization, you confirm you have authority to
            bind that organization.
          </p>

          <Section title="1. The service">
            Flow reads invoices and vendor statements submitted by email or upload, extracts
            their data, routes them through an approval workflow you configure, and — where you
            choose to connect it — syncs approved bills to QuickBooks Online. Features and plan
            limits are described on the Billing page and may change as the product evolves; we
            will give reasonable notice of changes that materially reduce functionality you are
            actively paying for.
          </Section>

          <Section title="2. Accounts, organizations, and roles">
            Access to Flow is organized around an &quot;organization&quot; — your company or a
            single client entity you manage. Each organization has its own users, invoices, and
            configuration, isolated from every other organization on the platform. Members hold
            one of a small set of roles (admin, approver, general user, or read-only auditor);
            an organization&apos;s admins are responsible for who holds those roles and what they
            can see. You are responsible for maintaining the confidentiality of your login
            credentials and for activity that happens under your account.
          </Section>

          <Section title="3. Free trial">
            A new organization may receive a free trial period, currently 14 days, with full
            access to the product and no payment required. We may change the length or
            availability of future trials at our discretion. If no paid plan is chosen before the
            trial ends, the organization moves to a read-only state — existing data remains
            fully visible, but approving or adding new invoices requires selecting a plan.
          </Section>

          <Section title="4. Subscriptions, billing, and payment">
            Paid use of Flow is billed under one of the plans described on the Billing page, each
            with a monthly document allowance and a per-document rate for usage beyond it. Fees
            are billed in USD via our payment processor and are due as invoiced; except where
            required by law, fees already paid are non-refundable. We may change plan pricing on
            a going-forward basis with notice; continued use after a price change takes effect
            constitutes acceptance of the new price.
          </Section>

          <Section title="5. Your content and data">
            You retain all ownership rights in the invoices, statements, vendor and workflow
            data, and other content your organization submits to Flow (&quot;Your Content&quot;).
            You grant us a limited license to host, process, transmit, and display Your Content
            solely to provide and improve the service for you. You are responsible for having the
            rights necessary to submit Your Content and for its accuracy — Flow is a processing
            and routing tool, not a substitute for your own review before approving a bill.
          </Section>

          <Section title="6. Automated extraction and AI processing">
            Flow uses third-party AI models to read and extract data from the documents you
            submit. We do not use Your Content to train our own models, and we do not sell it.
            Extraction results are a starting point, not a guarantee of accuracy — totals, line
            items, and vendor details should be checked as part of your own approval process
            before a bill is paid. Documents are shared with our AI processing sub-processor
            (see our Privacy Policy) only as needed to perform extraction.
          </Section>

          <Section title="7. Third-party integrations">
            Connecting Flow to QuickBooks Online or any other third-party service is optional and
            initiated by your organization&apos;s admin. Once connected, data is synced according
            to the settings you choose; disconnecting at any time stops future syncing but does
            not undo bills already pushed. We are not responsible for the availability or
            behavior of third-party services we integrate with.
          </Section>

          <Section title="8. Acceptable use">
            You agree not to: use Flow for any unlawful purpose; upload content you don&apos;t
            have the right to share; attempt to disrupt, reverse-engineer, or gain unauthorized
            access to Flow or another organization&apos;s data; or use the service to build a
            competing product. We may suspend or terminate access for a violation of this
            section.
          </Section>

          <Section title="9. Intellectual property">
            Flow, its software, design, and branding are owned by the Company and its licensors.
            These Terms grant you a limited, non-exclusive, non-transferable right to use Flow
            for your own internal business purposes — nothing here transfers ownership of the
            underlying software to you.
          </Section>

          <Section title="10. Disclaimers">
            Flow is provided &quot;as is&quot; and &quot;as available.&quot; To the maximum
            extent permitted by law, we disclaim all warranties, express or implied, including
            fitness for a particular purpose and non-infringement. We do not warrant that
            extraction results will be error-free or that the service will be uninterrupted.
          </Section>

          <Section title="11. Limitation of liability">
            To the maximum extent permitted by law, the Company will not be liable for indirect,
            incidental, or consequential damages, or for lost profits or data, arising from use
            of Flow. Our total liability for any claim relating to Flow will not exceed the fees
            you paid us in the twelve months before the claim arose.
          </Section>

          <Section title="12. Indemnification">
            You agree to indemnify and hold the Company harmless from claims arising out of Your
            Content, your use of Flow in violation of these Terms, or your violation of any law
            or third-party right.
          </Section>

          <Section title="13. Termination">
            You may stop using Flow and close your organization&apos;s account at any time. We
            may suspend or terminate access for a material breach of these Terms that is not
            cured after notice, or immediately for conduct that creates legal or security risk.
            Sections of these Terms that by their nature should survive termination (ownership,
            disclaimers, limitation of liability, indemnification) will survive.
          </Section>

          <Section title="14. Changes to these terms">
            We may update these Terms from time to time. For material changes, we will provide
            reasonable notice (such as an in-app notice or an email to your organization&apos;s
            admin) before the change takes effect. Continued use of Flow after a change takes
            effect constitutes acceptance of the updated Terms.
          </Section>

          <Section title="15. Governing law">
            These Terms are governed by the laws of the State of Wyoming, USA, without regard
            to its conflict-of-laws principles.
          </Section>

          <Section title="16. Contact">
            Questions about these Terms can be sent to{" "}
            <a href="mailto:support@ufirst.co" className="text-brand-green-dark underline">
              support@ufirst.co
            </a>
            .
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
