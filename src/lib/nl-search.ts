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
  // {id, name} — id is the real supplier_id (a real Supplier entity,
  // src/lib/dashboard-computations.ts's vendorOptionsFor and
  // applyViewAndFilters' advanced.supplier match), not the vendor's
  // display name. A version of this that used the name as the id used
  // to slip a bare vendor-name string into DocumentSearchFilters.supplier
  // — the "Filters" modal showed "1 selected" with no checkbox actually
  // checked (nothing in the real supplier_id list matched that string),
  // and the invoice query silently matched zero rows.
  vendors: { id: string; name: string }[];
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

// A function, not a module-level constant — this runs in a long-lived
// serverless instance, and a plain `const` built from `new Date()` at
// cold start would freeze "today" at whatever moment the instance
// happened to start, silently going stale for every request after that
// until the next cold start. Computed fresh on every call instead.
//
// Reported live: "battlefield invoice for August 27th" (voice, no year
// spoken) came back as dateFrom/dateTo "2024-08-27" — the model had no
// idea what year "now" actually was and picked one out of its training
// data, missing the real (2026) invoice entirely even though every
// other part of the filter (the supplier) resolved correctly. The
// model needs to be told today's date explicitly; it can't infer it.
function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You extract search intent from a user's plain-English invoice search. Return ONLY a JSON object (no markdown, no commentary) with exactly this shape — every field optional, omit anything the query doesn't mention:
{
  "status": string[],        // from: ${STATUS_VALUES.join(", ")}
  "holderHint": string,      // a person's name mentioned as currently holding/waiting on it
  "requesterHint": string,   // a person's name mentioned as who submitted it
  "approvedByHint": string,  // a person's name mentioned as who already approved it
  "nameHints": string[],     // every OTHER proper name/phrase mentioned that could be a vendor, supplier, project, customer, or job name — you don't know the org's real lists, so include a name here even with no context word ("from", "project", etc.) telling you which category it is; that gets resolved separately
  "number": string,          // invoice number substring
  "dateFrom": "YYYY-MM-DD",
  "dateTo": "YYYY-MM-DD",
  "amountFrom": string,      // plain number
  "amountTo": string
}

Today's date is ${today}. When the user gives a date with no year
("August 27th", "8/27"), use the year from today's date above — never
guess or default to any other year. A single specific day mentioned
("for August 27th", "on the 27th") means dateFrom and dateTo are both
that same day.

Relative date ranges are computed from today's date above, dateFrom
through dateTo inclusive:
- "the last N days" / "past N days" → dateFrom = today minus (N-1) days, dateTo = today.
- "yesterday" → dateFrom and dateTo both today minus 1 day.
- "this week" → dateFrom = the most recent Monday on or before today, dateTo = today.
- "last week" → the full Monday-through-Sunday week before this week's Monday.
- "this month" → dateFrom = the 1st of today's month, dateTo = today.
- "last month" → the full 1st-through-last-day of the calendar month before today's.
Do the actual date arithmetic yourself and output real YYYY-MM-DD
values — never leave a relative phrase unresolved.

Status meanings: "on_review" and "on_approval" and "on_hold" = still in the
approval pipeline, NOT yet approved. "approved" and "qbo_ready" = already
approved. "cancelled" and "rejected" = terminal, also not approved. A query
like "not approved yet" / "still pending" / "waiting" means
status: ["on_review", "on_approval", "on_hold"].

Every hint field is free text exactly as the user said it — you don't know
the org's real vendor/project/member names, so don't normalize or guess a
full name, just extract what was said. A bare query with no verb at all
(e.g. just "Sat Metal", or just "Clarington Toyota") is still a valid
search — put it in nameHints even though you can't tell what kind of name
it is.`;
}

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
          { role: "system", content: buildSystemPrompt() },
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

    const vendorCandidates = context.vendors.map((v) => ({ id: v.id, label: v.name }));
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

    // nameHints don't say whether they're a vendor or a project — try both
    // and keep whichever real list actually has a match. A hint that
    // matches nothing in either list is just dropped.
    const nameHints = Array.isArray(raw.nameHints)
      ? raw.nameHints.filter((h): h is string => typeof h === "string")
      : [];
    const supplier = new Set<string>();
    const customer = new Set<string>();
    for (const hint of nameHints) {
      for (const id of fuzzyMatch(hint, vendorCandidates)) supplier.add(id);
      for (const id of fuzzyMatch(hint, projectCandidates)) customer.add(id);
    }
    if (supplier.size > 0) result.supplier = [...supplier];
    if (customer.size > 0) result.customer = [...customer];
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
