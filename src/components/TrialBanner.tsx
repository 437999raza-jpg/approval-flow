import Link from "next/link";
import { isTrialActive } from "@/lib/plans";

// Renders nothing outside a trial. A quiet "N days left" strip while
// trialing, an amber "choose a plan" strip once it's lapsed with no plan
// ever picked (see isOrgLocked, plans.ts) — the latter is the one place
// the trial's soft lock actually surfaces on every page, not just
// wherever a locked action happened to be attempted. Server component —
// no client state needed, just today's date vs. a timestamp.
export function TrialBanner({
  plan,
  trialEndsAt,
}: {
  plan: string | null;
  trialEndsAt: string | null;
}) {
  if (trialEndsAt == null) return null;
  if (plan != null) return null; // a chosen plan always overrides trial messaging

  if (isTrialActive(trialEndsAt)) {
    const daysLeft = Math.max(
      1,
      Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    );
    return (
      <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-brand-line bg-brand-mist px-4 py-2 text-xs text-brand-navy">
        <span>
          {daysLeft} day{daysLeft === 1 ? "" : "s"} left in your trial.
        </span>
        <Link href="/billing" className="font-medium hover:underline">
          Choose a plan →
        </Link>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
      <span>
        Your trial has ended — you can still see everything, but approving or adding invoices
        needs a plan.
      </span>
      <Link href="/billing" className="font-semibold hover:underline">
        Choose a plan →
      </Link>
    </div>
  );
}
