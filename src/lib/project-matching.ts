// Working out which job an invoice belongs to.
//
// The old matcher did one thing: strip every non-alphanumeric from the
// PO number and the project name and check the PO started with the code.
// That has three problems, and the first is a wrong answer rather than a
// missing one:
//
//   "2021-12" is a prefix of "2021126...", so a PO for job 2021-126
//   could be filed against job 2021-12. Longest-match hid it most of the
//   time and would not have hidden it forever.
//
//   The code had to START the PO, so "PO-2022-58" matched nothing.
//
//   Nothing but the PO was ever consulted — the job code sitting in a
//   line description or the memo was invisible.
//
// This looks in every piece of text on the bill, respects digit
// boundaries so 2021-12 can never swallow 2021-126, and returns a
// confidence with a human-readable reason rather than a bare id. Where
// two jobs are equally plausible it returns nothing: on a construction
// bill the wrong job is worse than no job, because no job gets noticed
// and corrected while a wrong one gets approved.
//
// Authored by Araza.

export interface ProjectCandidate {
  id: string;
  name: string;
}

export interface ProjectMatch {
  projectId: string;
  confidence: "high" | "medium" | "low";
  // Shown to a human and written to the audit trail, so a match can be
  // argued with rather than just trusted.
  reason: string;
}

// Job naming is a per-tenant convention and this cannot assume any one
// of them. Fluid uses "2026-143 (GNMI Toronto)"; the next customer might
// use "JOB-4471 Riverside Mall", "RM02 — Smith Residence", or nothing
// but a name. So a project yields up to two identifiers and either can
// carry the match:
//
//   a CODE — the leading token, whatever shape it takes, as long as it
//   looks like an identifier rather than a word
//   a LABEL — the descriptive remainder
//
// The year/number split is recognised WHEN PRESENT because it enables
// the leading-zero and separator tolerance that "2022-058" vs "2022-58"
// needs. It is an optimisation for that shape, never a requirement.
const YEAR_NUMBER_RE = /^(z?\d{4})\s*[-–—]\s*(\d{1,4})\b/i;

// A leading token counts as a code when it carries a digit — "JOB-4471",
// "RM02", "2026-143" — because a purely alphabetic first word is part of
// the name ("Riverside Mall"), not an identifier, and matching on it
// would fire on any bill that happened to mention the word.
const LEADING_TOKEN_RE = /^([a-z0-9][a-z0-9._\/-]{1,23})(?=[\s>(:]|$)/i;

export interface ParsedProject {
  id: string;
  name: string;
  // Present only for the YYYY-NN shape, which gets separator and
  // leading-zero tolerance. Null for every other convention.
  year: string | null;
  number: string | null;
  // The code as the job is actually written — "2026-143", "Z2023-08" —
  // so a reason shown to a human quotes what they'd recognise rather
  // than a normalised form.
  // The code as the job is actually written — "2026-143", "JOB-4471" —
  // so a reason quotes what a human would recognise. Null when the job
  // has no identifier, only a name.
  code: string | null;
  // Alphanumerics only, for matching a PO typed without separators.
  digits: string;
  label: string;
}

export function parseProject(p: ProjectCandidate): ParsedProject | null {
  const name = p.name.trim();
  if (!name) return null;

  const ym = YEAR_NUMBER_RE.exec(name);
  if (ym) {
    const rest = name.slice(ym[0].length);
    return {
      id: p.id,
      name,
      year: ym[1].toLowerCase(),
      // Leading zeros dropped so "2022-058" and "2022-58" are one job.
      number: String(parseInt(ym[2], 10)),
      code: ym[0].trim(),
      digits: `${ym[1]}${ym[2]}`.toLowerCase().replace(/[^0-9a-z]/g, ""),
      label: cleanLabel(rest),
    };
  }

  // Any other convention: take the leading token if it looks like an
  // identifier, and treat the rest as the label.
  const lt = LEADING_TOKEN_RE.exec(name);
  const code = lt && /\d/.test(lt[1]) ? lt[1] : null;
  const label = cleanLabel(code ? name.slice(code.length) : name);
  if (!code && !label) return null;

  return {
    id: p.id,
    name,
    year: null,
    number: null,
    code,
    digits: (code ?? "").toLowerCase().replace(/[^0-9a-z]/g, ""),
    label,
  };
}

function cleanLabel(rest: string): string {
  return rest
    .replace(/^[\s>(:_.-]+/, "")
    .replace(/[)\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Find a job code in text, allowing the separators people actually type
// and REQUIRING that no digit follows — which is what stops 2021-12
// matching inside 2021-126.
function codeAppearsIn(text: string, p: ParsedProject): boolean {
  // YYYY-NN gets separator and leading-zero tolerance, and a guard
  // against a following digit — which is what stops 2021-12 matching
  // inside 2021-126.
  if (p.year && p.number) {
    // The year is matched exactly, INCLUDING a "Z" prefix. Treating that
    // Z as optional seemed generous and was wrong: it made "Z2024-01"
    // also match a plain "2024-01", so those two real jobs tied and both
    // were discarded as ambiguous. A Z job has to be cited as one.
    const y = p.year.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Either a real separator character between year and number, or
    // nothing at all — never whitespace on its own.
    //
    // Whitespace alone matched a DATE: "CONTAINER … TUE AUG 04/2026
    // 07:00" was read as job 2026-07 and would have filed that bill
    // against a job it has nothing to do with. Dates put a space there;
    // job codes put a hyphen or nothing.
    return new RegExp(
      `(^|[^0-9a-z])${y}(?:\\s*[-–—_./]\\s*|)0*${p.number}(?![0-9])`,
      "i"
    ).test(text);
  }
  if (!p.code) return false;
  // Any other convention is matched literally, with boundaries either
  // side so "RM02" cannot match inside "RM021".
  const escaped = p.code.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return new RegExp(`(^|[^0-9a-z])${escaped}(?![0-9a-z])`, "i").test(text);
}

// A label is only usable as evidence when it's distinctive. "Toronto" or
// "Phase 2" appear on half the jobs in a construction file, and matching
// on them would be worse than not matching at all.
function distinctiveLabel(label: string, all: ParsedProject[]): string | null {
  const cleaned = label.replace(/\s+/g, " ").trim();
  if (cleaned.length < 8) return null;
  const lower = cleaned.toLowerCase();
  const sharing = all.filter((p) => p.label.toLowerCase() === lower).length;
  return sharing === 1 ? lower : null;
}

export interface MatchSignals {
  // Strongest: the supplier wrote the job number on the PO.
  poNumber?: string | null;
  // Weaker, but common — the code turns up in a line description, the
  // memo, or the invoice number itself.
  texts?: (string | null | undefined)[];
}

export function matchProject(
  projects: ProjectCandidate[],
  signals: MatchSignals
): ProjectMatch | null {
  const parsed = projects
    .map(parseProject)
    .filter((p): p is ParsedProject => p !== null);
  if (parsed.length === 0) return null;

  const po = (signals.poNumber ?? "").trim();
  const otherText = (signals.texts ?? [])
    .filter((t): t is string => Boolean(t && t.trim()))
    .join(" \n ");

  const scored: { p: ParsedProject; score: number; reason: string }[] = [];
  const digitPrefix: ParsedProject[] = [];

  // A PO typed without separators — "20211261234". The boundary rule
  // can't help here: that string really could be job 2021-126 followed
  // by 1234, or job 2021-12 followed by 61234. Longest code wins, which
  // is the old behaviour, but it scores lower because it IS a guess.
  const poDigits = po.toLowerCase().replace(/[^0-9a-z]/g, "");
  const poHasSeparator = /[^0-9a-z]/.test(po);

  for (const p of parsed) {
    if (po && codeAppearsIn(po, p)) {
      scored.push({ p, score: 100, reason: `job ${p.code} on the PO number` });
      continue;
    }
    if (!poHasSeparator && poDigits && p.digits && poDigits.startsWith(p.digits)) {
      // Collected, not scored: see below. Longest-wins was tempting and
      // wrong — across Fluid's 456 real jobs it files 12 of them against
      // the wrong one.
      digitPrefix.push(p);
      continue;
    }
    if (otherText && codeAppearsIn(otherText, p)) {
      scored.push({ p, score: 60, reason: `job ${p.code} written on the bill` });
      continue;
    }
    // Labels are searched in the PO field too. In practice that field
    // holds whatever reference the supplier wrote — Fluid's real bills
    // carry "CLARINGTON TOYOTA" and "2023-16 WHITBY TOYOTA" in it — so
    // treating it as strictly a number missed the job sitting in plain
    // sight.
    const label = distinctiveLabel(p.label, parsed);
    if (label && `${po} ${otherText}`.toLowerCase().includes(label)) {
      scored.push({ p, score: 30, reason: `"${p.label}" named on the bill` });
    }
  }

  // A PO typed with no separators at all is only usable when exactly one
  // job's code can start it. "20211261234" could be job 2021-126 then
  // 1234, or job 2021-12 then 61234 — nothing in the string says which,
  // and picking the longer one is a coin toss dressed as a rule. Tested
  // against all 456 of Fluid's jobs: longest-wins mis-files twelve.
  if (digitPrefix.length === 1) {
    const only = digitPrefix[0];
    scored.push({
      p: only,
      score: 70,
      reason: `PO number starts with job ${only.code}`,
    });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  // Two jobs matched equally well — say nothing rather than pick one.
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;

  const best = scored[0];
  return {
    projectId: best.p.id,
    // A separator-free PO prefix scores in the 70s: better than a
    // mention buried in a description, short of the certainty of a code
    // with real boundaries around it.
    confidence: best.score >= 100 ? "high" : best.score >= 60 ? "medium" : "low",
    reason: best.reason,
  };
}
