import { recordLlmUsage } from "@/lib/llm-usage";
import type { DocumentSearchFilters } from "@/components/DocumentSearchModal";

// Translates a plain-English dashboard search ("show me invoices from Sat
// Metal that aren't approved yet") into the SAME DocumentSearchFilters
// shape the "Filters" modal already produces — never raw SQL, never a
// direct DB query.
//
// Two-step, not one: the model only ever extracts plain-text HINTS (a
// name it heard, not an id) — it never sees the org's real vendor/
// project/member lists. Matching those hints to real records happens
// here afterward, via a simple case-insensitive substring match. This
// used to hand the model the full lists inline instead, which was fine
// for a handful of vendors but blew up the prompt to 20k+ tokens (and
// ~$0.02/search) for an org with hundreds of projects — and would only
// get worse as any org's project list grows. The fuzzy-match approach
// costs a few hundred tokens flat regardless of org size, and is also
// more forgiving of a partial name ("Sat Metal" matching "Sat Metal
// Fabricators Inc.") than asking the model to echo back an exact string
// ever was. Authored by Araza.

export interface SearchLookupContext {
  vendors: string[];
  projects: { id: string; name: string }[];
  members: { id: string; name: string }[];
}

const STATUS_VALUES = [
  "on_review",
  "on_approval",
  "qbo_ready",
  "approved",
  "cancelled",
  "rejected",
  "on_hold",
] as const;
type StatusValue = (typeof STATUS_VALUES)[number];

const SYSTEM_PROMPT = `You extract search intent from a user's plain-English invoice search. Return ONLY a JSON object (no markdown, no commentary) with exactly this shape — every field optional, omit anything the query doesn't mention:
{
  "status": string[],        // from: ${STATUS_VALUES.join(", ")}
  "holderHint": string,      // a name mentioned as currently holding/waiting on it
  "requesterHint": string,   // a name mentioned as who submitted it
  "approvedByHint": string,  // a name mentioned as who already approved it
  "supplierHint": string,    // a vendor/supplier name mentioned, verbatim as heard
  "customerHint": string,    // a project/customer/job name mentioned, verbatim as heard
  "number": string,          // invoice number substring
  "dateFrom": "YYYY-MM-DD",
  "dateTo": "YYYY-MM-DD",
  "amountFrom": string,      // plain number
  "amountTo": string
}

Status meanings: "on_review" and "on_approval" and "on_hold" = still in the
approval pipeline, NOT yet approved. "approved" and "qbo_ready" = already
approved. "cancelled" and "rejected" = terminal, also not approved. A query
like "not approved yet" / "still pending" / "waiting" means
status: ["on_review", "on_approval", "on_hold"].

Every *Hint field is free text exactly as the user said it — you don't know
the org's real vendor/project/member names, so don't normalize or guess a
full name, just extract what was said.`;

function isStatusValue(v: unknown): v is StatusValue {
  return typeof v === "string" && (STATUS_VALUES as readonly string[]).includes(v);
}

// Case-insensitive, either-direction substring match — "Sat Metal" matches
// "Sat Metal Fabricators Inc.", and vice versa. Returns every candidate
// that matches, since a DocumentSearchFilters field is an OR-of-values
// multi-select anyway.
function fuzzyMatch(hint: unknown, candidates: { id: string; label: string }[]): string[] {
  if (typeof hint !== "string" || !hint.trim()) return [];
  const needle = hint.trim().toLowerCase();
  return candidates
    .filter((c) => {
      const label = c.label.toLowerCase();
      return label.includes(needle) || needle.includes(label);
    })
    .map((c) => c.id);
}

export async function parseNaturalLanguageSearch(
  query: string,
  context: SearchLookupContext,
  organizationId: string
): Promise<Partial<DocumentSearchFilters> | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENROUTER_SEARCH_MODEL || "anthropic/claude-haiku-4.5";

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        response_format: { type: "json_object" },
        usage: { include: true },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
      }),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
      };
    };
    await recordLlmUsage(organizationId, "search", model, body.usage);

    const text = body.choices?.[0]?.message?.content;
    if (!text) return null;

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const raw = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text) as Record<
      string,
      unknown
    >;

    const vendorCandidates = context.vendors.map((v) => ({ id: v, label: v }));
    const projectCandidates = context.projects.map((p) => ({ id: p.id, label: p.name }));
    const memberCandidates = context.members.map((m) => ({ id: m.id, label: m.name }));

    const result: Partial<DocumentSearchFilters> = {};
    const status = Array.isArray(raw.status) ? raw.status.filter(isStatusValue) : [];
    if (status.length > 0) result.status = status;
    const holder = fuzzyMatch(raw.holderHint, memberCandidates);
    if (holder.length > 0) result.holder = holder;
    const requester = fuzzyMatch(raw.requesterHint, memberCandidates);
    if (requester.length > 0) result.requester = requester;
    const approvedBy = fuzzyMatch(raw.approvedByHint, memberCandidates);
    if (approvedBy.length > 0) result.approvedBy = approvedBy;
    const supplier = fuzzyMatch(raw.supplierHint, vendorCandidates);
    if (supplier.length > 0) result.supplier = supplier;
    const customer = fuzzyMatch(raw.customerHint, projectCandidates);
    if (customer.length > 0) result.customer = customer;
    if (typeof raw.number === "string" && raw.number.trim()) result.number = raw.number.trim();
    if (typeof raw.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateFrom))
      result.dateFrom = raw.dateFrom;
    if (typeof raw.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateTo))
      result.dateTo = raw.dateTo;
    if (typeof raw.amountFrom === "string" && raw.amountFrom.trim())
      result.amountFrom = raw.amountFrom.trim();
    if (typeof raw.amountTo === "string" && raw.amountTo.trim())
      result.amountTo = raw.amountTo.trim();

    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    console.error("parseNaturalLanguageSearch error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
