// Flow's three fixed monthly plans — replaces the old admin-editable
// "$/document" rate. Priced against comparable tools researched directly:
// ApprovalMax's old flat tiers ($59.40/$95/$133.10/mo) and Dext's
// per-user-bundle pricing (~$25-31/mo for 5 users + 250 docs) — Flow
// combines what ApprovalMax (approval routing) and Dext (invoice OCR/
// extraction) do separately into one product, priced below buying both.
// Authored by Araza.

export type PlanId = "starter" | "growth" | "scale";

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
    includedDocs: 50,
    overageRatePerDoc: 0.45,
    blurb: "A single org, light volume.",
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceUsd: 99,
    includedDocs: 150,
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
};

export const PLAN_ORDER: PlanId[] = ["starter", "growth", "scale"];

export function isPlanId(value: string | null | undefined): value is PlanId {
  return value === "starter" || value === "growth" || value === "scale";
}
