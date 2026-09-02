import Link from "next/link";
import { isTrialActive, resolvePlan, type OrgPlanContext } from "@/lib/plans";

// A full-bleed strip across the top of the app while an org is on trial:
// how long is left on the left, the way to fix it on the right. Renders
// nothing once there's a plan — including a negotiated custom one, which
// is why this takes the org row rather than a plan string (resolvePlan is
// the only thing that knows a custom plan counts).
//
// Deliberately quiet for most of the trial. A permanent banner that
// shouts from day one is one people stop seeing by day three, so the
// tone escalates instead: mist while there's time, amber in the last
// three days, rose once it's lapsed — which is also the only place the
// trial's soft lock (isOrgLocked, plans.ts) surfaces on every page
// rather than at whichever action happened to be blocked.
//
// Server component — no client state, just today's date vs a timestamp.

const URGENT_DAYS = 3;

export function TrialBanner({ org }: { org: OrgPlanContext | null | undefined }) {
  const trialEndsAt = org?.trial_ends_at ?? null;
  if (!org || org.is_internal || trialEndsAt == null) return null;
  if (resolvePlan(org) != null) return null; // a chosen plan overrides trial messaging

  const active = isTrialActive(trialEndsAt);
  const daysLeft = Math.max(
    1,
    Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  );
  const urgent = active && daysLeft <= URGENT_DAYS;

  const tone = !active
    ? {
        strip: "border-rose-200 bg-rose-50 text-rose-900",
        dot: "bg-rose-500",
        button: "bg-rose-600 text-white hover:bg-rose-700",
      }
    : urgent
      ? {
          strip: "border-amber-200 bg-amber-50 text-amber-900",
          dot: "bg-amber-500",
          button: "bg-amber-600 text-white hover:bg-amber-700",
        }
      : {
          // A wash of the brand green rather than the neutral mist — at 8%
          // it reads as "on trial, all good" instead of a system notice,
          // and it ties the strip to the green the button and the rest of
          // the app already use. Any stronger and a banner that sits on
          // every page all day starts competing with the content.
          strip: "border-brand-green/25 bg-brand-green/[0.08] text-brand-navy",
          dot: "bg-brand-green",
          button: "bg-brand-green text-white hover:bg-brand-green-dark",
        };

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 py-2 ${tone.strip}`}
    >
      <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
        <span className={`h-1.5 w-1.5 flex-none rounded-full ${tone.dot}`} aria-hidden />
        {active ? (
          <span>
            <span className="font-semibold">
              {daysLeft} day{daysLeft === 1 ? "" : "s"} left
            </span>{" "}
            in your free trial — full access, nothing to pay yet.
          </span>
        ) : (
          <span>
            <span className="font-semibold">Your free trial has ended.</span> Everything stays
            visible, but approving and adding invoices needs a plan.
          </span>
        )}
      </div>
      <Link
        href="/billing"
        className={`flex-none rounded-lg px-3 py-1.5 text-[13px] font-display font-bold transition-colors ${tone.button}`}
      >
        Choose a plan
      </Link>
    </div>
  );
}
