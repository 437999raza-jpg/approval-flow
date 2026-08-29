import { recordLlmUsage } from "@/lib/llm-usage";
import type { DocumentSearchFilters } from "@/components/DocumentSearchModal";

// Translates a plain-English dashboard search ("show me invoices from Sat
// Metal that aren't approved yet") into the SAME DocumentSearchFilters
// shape the "Filters" modal already produces — never raw SQL, never a
// direct DB query. The model can only ever pick a vendor/project/member
// that's handed to it below (validated again on the way back), so a bad
// answer degrades to "no match" or a slightly-wrong filter, never a
// cross-org leak or an arbitrary query. Authored by Araza.

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

function buildSystemPrompt(context: SearchLookupContext): string {
  return `You translate a user's plain-English invoice search into a JSON filter object. Return ONLY a JSON object (no markdown, no commentary) with exactly this shape — every field optional, omit anything the query doesn't mention:
{
  "status": string[],       // from: ${STATUS_VALUES.join(", ")}
  "holder": string[],       // member ids — who currently has it (waiting on / with X)
  "requester": string[],    // member ids — who submitted it
  "approvedBy": string[],   // member ids — who already approved it
  "supplier": string[],     // EXACT vendor name strings from the list below
  "customer": string[],     // project ids, from the list below
  "number": string,         // invoice number substring
  "dateFrom": "YYYY-MM-DD",
  "dateTo": "YYYY-MM-DD",
  "amountFrom": string,     // plain number
  "amountTo": string
}

Status meanings: "on_review" and "on_approval" and "on_hold" = still in the
approval pipeline, NOT yet approved. "approved" and "qbo_ready" = already
approved. "cancelled" and "rejected" = terminal, also not approved. A query
like "not approved yet" / "still pending" / "waiting" means
status: ["on_review", "on_approval", "on_hold"].

Only use vendor names, project ids, and member ids that appear in these
lists — never invent one. If the query names someone/something not in a
list, omit that field entirely rather than guessing.

Vendors: ${context.vendors.length > 0 ? context.vendors.join(" | ") : "(none)"}
Projects (id: name): ${context.projects.length > 0 ? context.projects.map((p) => `${p.id}: ${p.name}`).join(" | ") : "(none)"}
Members (id: name): ${context.members.length > 0 ? context.members.map((m) => `${m.id}: ${m.name}`).join(" | ") : "(none)"}`;
}

function isStatusValue(v: unknown): v is StatusValue {
  return typeof v === "string" && (STATUS_VALUES as readonly string[]).includes(v);
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
        max_tokens: 512,
        response_format: { type: "json_object" },
        usage: { include: true },
        messages: [
          { role: "system", content: buildSystemPrompt(context) },
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

    const validVendors = new Set(context.vendors);
    const validProjectIds = new Set(context.projects.map((p) => p.id));
    const validMemberIds = new Set(context.members.map((m) => m.id));

    const strArray = (v: unknown, valid: Set<string>): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && valid.has(x)) : [];

    const result: Partial<DocumentSearchFilters> = {};
    const status = Array.isArray(raw.status) ? raw.status.filter(isStatusValue) : [];
    if (status.length > 0) result.status = status;
    const holder = strArray(raw.holder, validMemberIds);
    if (holder.length > 0) result.holder = holder;
    const requester = strArray(raw.requester, validMemberIds);
    if (requester.length > 0) result.requester = requester;
    const approvedBy = strArray(raw.approvedBy, validMemberIds);
    if (approvedBy.length > 0) result.approvedBy = approvedBy;
    const supplier = strArray(raw.supplier, validVendors);
    if (supplier.length > 0) result.supplier = supplier;
    const customer = strArray(raw.customer, validProjectIds);
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
