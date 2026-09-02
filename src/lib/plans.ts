// Flow's three fixed monthly plans — replaces the old admin-editable
// "$/document" rate. Priced against comparable tools researched directly:
// ApprovalMax's old flat tiers ($59.40/$95/$133.10/mo) and Dext's
// per-user-bundle pricing (~$25-31/mo for 5 users + 250 docs) — Flow
// combines what ApprovalMax (approval routing) and Dext (invoice OCR/
// extraction) do separately into one product, priced below buying both.
// Authored by Araza.

export type PlanId = "starter" | "growth" | "scale" | "detailed";

export interface Plan {
  id: PlanId;
  name: string;
  priceUsd: number;
  includedDocs: number;
  overageRatePerDoc: number;
  blurb: string;
}

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceUsd: 49,
    includedDocs: 100,
    overageRatePerDoc: 0.45,
    blurb: "A single org, light volume.",
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceUsd: 99,
    includedDocs: 200,
    overageRatePerDoc: 0.35,
    blurb: "Multiple workflows, deadlines and escalation in real use.",
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceUsd: 199,
    includedDocs: 400,
    overageRatePerDoc: 0.25,
    // Billing is strictly per-org (organizations.plan, one row each) —
    // this is the highest single-org volume tier, not a multi-org bundle.
    // A managing firm running several client orgs (e.g. ufirst) puts
    // EACH one on its own plan; there's no discounted "manage N orgs for
    // one price" tier yet (considered and deliberately deferred).
    blurb: "High-volume single org — heavy monthly document flow.",
  },
  detailed: {
    id: "detailed",
    name: "Detailed",
    priceUsd: 299,
    includedDocs: 700,
    overageRatePerDoc: 0.2,
    blurb: "Today's full line-by-line extraction, our most thorough plan — includes Statement Reconciliation.",
  },
};

export const PLAN_ORDER: PlanId[] = ["starter", "growth", "scale", "detailed"];

export function isPlanId(value: string | null | undefined): value is PlanId {
  return (
    value === "starter" || value === "growth" || value === "scale" || value === "detailed"
  );
}

// A negotiated per-org plan (organizations.custom_plan, migration 0095).
// Most of what we sell is bespoke — a client agrees their own price and
// volume, plus a one-time fee for us to build the product around their
// process — and before this those deals lived entirely outside the app,
// so their Billing page showed a plan grid that had nothing to do with
// what they'd signed.
export interface CustomPlanConfig {
  name: string;
  priceUsd: number;
  includedDocs: number;
  overageRatePerDoc: number;
  blurb?: string;
  statementReconciliation?: boolean;
  extraction?: ExtractionMode;
}

export type ExtractionMode = "simple" | "complex";

// What every caller downstream actually reads: one shape whether the org
// is on a fixed tier or a negotiated one, with the capabilities already
// resolved. Nothing outside this file should branch on which it was.
export interface ResolvedPlan {
  id: PlanId | "custom";
  name: string;
  priceUsd: number;
  includedDocs: number;
  overageRatePerDoc: number;
  blurb: string;
  isCustom: boolean;
  statementReconciliation: boolean;
  extraction: ExtractionMode;
}

// The org fields every plan decision needs. Callers select exactly these
// three columns; taking the row (rather than three loose arguments) is
// what stops a call site from resolving a plan while quietly forgetting
// that the org has a custom one.
export interface OrgPlanContext {
  plan?: string | null;
  custom_plan?: unknown;
  trial_ends_at?: string | null;
  // House account (migration 0096) — full access, never billed, never
  // locked, never shown trial or payment messaging.
  is_internal?: boolean | null;
}

// custom_plan is JSONB, so it carries no type guarantees at all — a
// hand-entered deal could be half-written or malformed. Anything that
// doesn't parse cleanly is treated as no custom plan rather than
// crashing the Billing page or, worse, silently resolving to $0.
export function parseCustomPlan(value: unknown): CustomPlanConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const name = typeof v.name === "string" ? v.name.trim() : "";
  const priceUsd = Number(v.priceUsd);
  const includedDocs = Number(v.includedDocs);
  const overageRatePerDoc = Number(v.overageRatePerDoc);
  if (!name) return null;
  if (!Number.isFinite(priceUsd) || priceUsd < 0) return null;
  if (!Number.isFinite(includedDocs) || includedDocs < 0) return null;
  if (!Number.isFinite(overageRatePerDoc) || overageRatePerDoc < 0) return null;
  return {
    name,
    priceUsd,
    includedDocs: Math.round(includedDocs),
    overageRatePerDoc,
    blurb: typeof v.blurb === "string" ? v.blurb : undefined,
    statementReconciliation: v.statementReconciliation === true,
    extraction: v.extraction === "simple" ? "simple" : "complex",
  };
}

// The single place a plan is decided. A custom plan wins over the fixed
// tier: it's the negotiated deal, and organizations.plan may well still
// hold whatever tier the org was on before we agreed one.
export function resolvePlan(org: OrgPlanContext | null | undefined): ResolvedPlan | null {
  if (!org) return null;

  const custom = parseCustomPlan(org.custom_plan);
  if (custom) {
    return {
      id: "custom",
      name: custom.name,
      priceUsd: custom.priceUsd,
      includedDocs: custom.includedDocs,
      overageRatePerDoc: custom.overageRatePerDoc,
      blurb: custom.blurb ?? "Negotiated plan, built around your process.",
      isCustom: true,
      // A bespoke deal is explicit about what it includes — an omitted
      // flag means "not included", never "inherit from a tier".
      statementReconciliation: custom.statementReconciliation === true,
      extraction: custom.extraction ?? "complex",
    };
  }

  if (!isPlanId(org.plan)) return null;
  const plan = PLANS[org.plan];
  return {
    ...plan,
    isCustom: false,
    // Detailed is the one fixed tier that includes these — kept here
    // rather than at each call site so a future tier that also includes
    // them is a one-line change.
    statementReconciliation: plan.id === "detailed",
    extraction: plan.id === "detailed" ? "complex" : "simple",
  };
}

// Self-serve signup grants a 14-day trial (organizations.trial_ends_at)
// with full product access, no tier restriction — set only by
// completeSelfSignup (src/lib/auth-actions.ts); an org provisioned via
// the platform-admin /admin/organizations flow has no trial clock at
// all (trial_ends_at stays null forever for those).
export function isTrialActive(trialEndsAt: string | null | undefined): boolean {
  return trialEndsAt != null && new Date(trialEndsAt) > new Date();
}

// Soft-locked (read-only) once a trial that was actually granted has
// lapsed with no plan ever chosen. An org with no trial at all
// (trial_ends_at null) is never locked by this — that's the
// platform-admin-provisioned case, always billed by hand today. A
// negotiated custom plan counts as a plan, so an org we built for is
// never locked out of the thing we built.
export function isOrgLocked(org: OrgPlanContext): boolean {
  if (org.is_internal) return false;
  return (
    org.trial_ends_at != null &&
    !isTrialActive(org.trial_ends_at) &&
    resolvePlan(org) == null
  );
}

// Statement Reconciliation is the first plan-gated feature. Full access
// during an active trial is the point of the trial, so it passes here
// too, independent of plan.
export function hasStatementReconciliation(org: OrgPlanContext | null | undefined): boolean {
  if (org?.is_internal) return true;
  if (isTrialActive(org?.trial_ends_at)) return true;
  return resolvePlan(org)?.statementReconciliation === true;
}

// Extraction depth is derived from plan, never a separate switch — an org
// gets billed for a tier and gets exactly the extraction that tier
// promises, with no way for the two to drift apart. An active trial gets
// "complex" too, same as every other trial-time feature.
export function extractionModeForOrg(org: OrgPlanContext | null | undefined): ExtractionMode {
  if (org?.is_internal) return "complex";
  if (isTrialActive(org?.trial_ends_at)) return "complex";
  return resolvePlan(org)?.extraction ?? "simple";
}

// One-time build/onboarding fee (organizations.setup_fee_*, migration
// 0095) — independent of plan, since a standard-plan customer can pay
// for a custom build too.
export interface SetupFee {
  amountUsd: number;
  label: string;
  paidAt: string | null;
  outstanding: boolean;
}

export function resolveSetupFee(org: {
  setup_fee_usd?: number | string | null;
  setup_fee_label?: string | null;
  setup_fee_paid_at?: string | null;
} | null | undefined): SetupFee | null {
  // numeric() comes back from PostgREST as a string, not a number.
  const amount = Number(org?.setup_fee_usd);
  if (!org || !Number.isFinite(amount) || amount <= 0) return null;
  const paidAt = org.setup_fee_paid_at ?? null;
  return {
    amountUsd: amount,
    label: org.setup_fee_label?.trim() || "Custom build & onboarding",
    paidAt,
    outstanding: paidAt == null,
  };
}
