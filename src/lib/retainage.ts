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
// Broad on purpose and across all three markets from the start, because
// matching is just a word list — and a missed line means paying a sub
// the full gross when 10% should have been withheld.
//
// Two kinds, because they can't be matched the same way:
//
//   Phrases are safe as substrings — no ordinary line description
//   contains "holdback" or "retainage" by accident.
//
//   Abbreviations are not. Fluid's subs write "10% HB" (seen on
//   Ridgeline Electric invoice 26-2422), and a plain substring test for
//   "hb" also fires on "highbay lighting". Those need word boundaries,
//   which is why this isn't one flat list.
const RETAINAGE_PHRASES: readonly string[] = [
  "holdback",
  "hold back",
  "hold-back",
  "statutory holdback",
  "retainage",
  "retention",
  "retained",
  "amount retained",
];

// Matched as whole words only: hb, h/b, h.b, h.b.
const RETAINAGE_ABBREVIATIONS = /(^|[^a-z0-9])(hb|h\/b|h\.b\.?)([^a-z0-9]|$)/;

export const RETAINAGE_LINE_PATTERNS: readonly string[] = RETAINAGE_PHRASES;

// True when a line's description looks like the retainage deduction
// rather than work performed.
//
// Callers MUST also check the amount is negative (or otherwise reduces
// the total) before acting on this. Genuine site work does collide:
// "Retention pond excavation" matches "retention" and is real work being
// billed, not money withheld. On invoice 26-2422 the holdback line is
// -2,777.92 against a +27,779.20 line, and that sign is what separates
// the two every time.
export function looksLikeRetainageLine(description: string | null | undefined): boolean {
  if (!description) return false;
  const d = description.toLowerCase().replace(/\s+/g, " ").trim();
  if (RETAINAGE_PHRASES.some((p) => d.includes(p))) return true;
  return RETAINAGE_ABBREVIATIONS.test(d);
}

// The rate that applies to one invoice, or null for no retainage at all.
//
// The supplier decides first, and decides absolutely: holdback is a
// property of the RELATIONSHIP, not of the bill. A subcontractor working
// under a contract is subject to it; screws from Home Depot and a
// container rented from Battlefield are not, however the invoice is
// worded. An unflagged supplier returns null here and nothing downstream
// accrues — which is also what stops a stray "retention pond" line on a
// materials invoice from ever triggering an accrual.
//
// Only then does the rate resolve: the job's own rate if it has one,
// otherwise the org default (10% across Ontario, and the only rate seen
// in practice — but still configuration, since US retainage varies by
// state and steps down mid-project).
export function resolveRetainageRate(
  org: { retainage_default_rate?: number | string | null } | null | undefined,
  project?: { retainage_rate?: number | string | null } | null,
  supplier?: { is_subcontractor?: boolean | null } | null
): number | null {
  if (!supplier?.is_subcontractor) return null;
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

// Real subcontractor bills pair each work line with its own deduction
// immediately below it — Senoz Electric invoice 4564 runs seven such
// pairs, Ridgeline 26-2422 one. Across every holdback line in Fluid's
// production data the deduction is exactly the rate applied to the line
// directly above, to the cent.
//
// That pairing is a far stronger signal than the wording is, and it's
// what turns detection from "this line says HB" into "this line says HB
// AND it is 10% of the line above, negative". It also catches the sub
// who quietly withholds 5% when the contract says 10%.
export interface RetainagePair {
  grossAmount: number;
  retainageAmount: number; // positive
  impliedRate: number;     // percent
  matchesExpected: boolean;
}

export function pairWithPrecedingLine(
  grossAmount: number | null | undefined,
  retainageLineAmount: number | null | undefined,
  expectedRate: number | null,
  tolerancePercent = 0.05
): RetainagePair | null {
  if (
    grossAmount == null ||
    retainageLineAmount == null ||
    !Number.isFinite(grossAmount) ||
    !Number.isFinite(retainageLineAmount) ||
    grossAmount <= 0
  ) {
    return null;
  }
  // The deduction must actually reduce the bill. This is the check that
  // keeps "Retention pond excavation" — real work, positive amount —
  // from ever being read as money withheld.
  if (retainageLineAmount >= 0) return null;

  const amount = Math.abs(retainageLineAmount);
  const impliedRate = Math.round((amount / grossAmount) * 10000) / 100;
  return {
    grossAmount,
    retainageAmount: amount,
    impliedRate,
    matchesExpected:
      expectedRate == null
        ? false
        : Math.abs(impliedRate - expectedRate) <= tolerancePercent,
  };
}
