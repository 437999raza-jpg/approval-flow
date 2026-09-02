// Retainage / holdback: the percentage of every progress bill a
// construction contract withholds until the job is substantially
// complete.
//
// One mechanism, three vocabularies and no single rulebook:
//   Canada  "holdback"  — provincial construction acts. Ontario is 10%,
//                         released after substantial performance is
//                         published, then the lien period.
//   US      "retainage" — state-by-state prompt-pay statutes. Commonly
//                         5%, and often stepped down at 50% completion,
//                         which Canadian holdback does not do.
//   UK/AU   "retention" — contract terms, usually released in two
//                         halves (practical completion, then defects).
//
// So nothing here hardcodes a rate or a release rule: both are per-org
// and per-project configuration. What a customer READS is
// organizations.retainage_term, because software that calls it the wrong
// thing reads as built for somewhere else.
//
// Authored by Araza.

export type RetainageTerm = "holdback" | "retainage" | "retention";

interface TermCopy {
  noun: string;      // "Holdback"
  nounLower: string; // "holdback"
  plural: string;    // "Holdbacks"
}

const TERMS: Record<RetainageTerm, TermCopy> = {
  holdback: { noun: "Holdback", nounLower: "holdback", plural: "Holdbacks" },
  retainage: { noun: "Retainage", nounLower: "retainage", plural: "Retainage" },
  retention: { noun: "Retention", nounLower: "retention", plural: "Retention" },
};

export function termCopy(term: RetainageTerm | null | undefined): TermCopy {
  return TERMS[term ?? "holdback"] ?? TERMS.holdback;
}

// Every wording we've seen a subcontractor use for the deduction line.
// Deliberately covers all three markets from the start — matching is a
// word list, so breadth is free, and a missed line means silently
// overpaying a sub by the full retained percentage.
//
// Kept lowercase; callers normalise before testing.
export const RETAINAGE_LINE_PATTERNS: readonly string[] = [
  "holdback",
  "hold back",
  "hold-back",
  "statutory holdback",
  "retainage",
  "retention",
  "retained",
  "less retainage",
  "less holdback",
  "less retention",
  "amount retained",
];

// True when a line's description looks like the retainage deduction
// rather than work performed.
//
// Callers MUST also check the amount is negative (or otherwise reduces
// the total) before acting on this. The list matches whole terms, so
// "Retaining wall — 40 lin ft" is safely ignored, but genuine site work
// does collide: "Retention pond excavation" matches "retention" and is
// real work being billed, not money being withheld. The sign of the
// amount is what separates the two, every time.
export function looksLikeRetainageLine(description: string | null | undefined): boolean {
  if (!description) return false;
  const d = description.toLowerCase().replace(/\s+/g, " ").trim();
  return RETAINAGE_LINE_PATTERNS.some((p) => d.includes(p));
}

// The rate that applies to one invoice: the job's own rate when it has
// one, otherwise the org default. Null means this org doesn't withhold
// retainage at all, which is most orgs — Flow is not construction-only.
export function resolveRetainageRate(
  org: { retainage_default_rate?: number | string | null } | null | undefined,
  project?: { retainage_rate?: number | string | null } | null
): number | null {
  const projectRate = toRate(project?.retainage_rate);
  if (projectRate != null) return projectRate;
  return toRate(org?.retainage_default_rate);
}

// numeric() comes back from PostgREST as a string.
function toRate(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}

// What to withhold from a given amount, rounded to cents. Returns 0 when
// no rate applies, so callers can use the number without branching.
export function retainageAmount(
  subtotal: number | null | undefined,
  rate: number | null
): number {
  if (rate == null || subtotal == null || !Number.isFinite(subtotal) || subtotal <= 0) {
    return 0;
  }
  return Math.round(subtotal * rate) / 100;
}

// A subcontractor's own claim invoice should equal what we accrued. Real
// ones rarely land to the cent — a sub rounds, or bills two jobs on one
// invoice — so this reports the gap rather than judging it, and the
// tolerance is what decides whether a human needs to look.
export interface ClaimVariance {
  expected: number;
  claimed: number;
  difference: number;
  withinTolerance: boolean;
}

export function compareClaim(
  expected: number,
  claimed: number,
  toleranceCents = 100
): ClaimVariance {
  const difference = Math.round((claimed - expected) * 100) / 100;
  return {
    expected,
    claimed,
    difference,
    withinTolerance: Math.abs(difference) * 100 <= toleranceCents,
  };
}

// Releasable once the job has a substantial-performance date and hasn't
// already been released. The waiting period after that date is
// jurisdictional (Ontario's lien period is not Texas's prompt-pay
// clock), so it's a parameter — never a constant in here.
export function isReleasable(
  project: {
    substantial_performance_at?: string | null;
    retainage_released_at?: string | null;
  } | null | undefined,
  waitDays = 0,
  now: Date = new Date()
): boolean {
  if (!project?.substantial_performance_at) return false;
  if (project.retainage_released_at) return false;
  const from = new Date(project.substantial_performance_at);
  if (Number.isNaN(from.getTime())) return false;
  return now.getTime() >= from.getTime() + waitDays * 24 * 60 * 60 * 1000;
}
