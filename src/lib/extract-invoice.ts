// Robust invoice extraction via OpenRouter (model-agnostic).
//
// Sends the invoice document (PDF or image) to the configured OpenRouter
// model and asks for a strict JSON object covering far more than the basic
// fields — line items, tax, subtotal, PO number, vendor contact details,
// customer, description — so the Bill panel and routing engine have real
// data to work with.
//
// Env:
//   OPENROUTER_API_KEY  — required for extraction (best-effort without it)
//   OPENROUTER_MODEL    — optional, e.g. "anthropic/claude-sonnet-4.5"
//
// Best-effort: any failure resolves to null rather than blocking ingestion.
// Authored by Araza.

export interface ExtractedLineItem {
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
  category: string | null;
  class: string | null;
  tax_rate: number | null;
}

export interface ExtractedInvoiceData {
  vendor_name: string | null;
  vendor_address: string | null;
  vendor_email: string | null;
  vendor_phone: string | null;
  invoice_number: string | null;
  bill_date: string | null; // YYYY-MM-DD
  due_date: string | null; // YYYY-MM-DD
  po_number: string | null;
  currency: string | null; // ISO 4217
  subtotal: number | null;
  tax_rate: number | null; // percentage, e.g. 13
  tax_amount: number | null;
  total_amount: number | null;
  customer: string | null;
  description: string | null;
  line_items: ExtractedLineItem[];
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

const SYSTEM_PROMPT = `You are an invoice data extraction engine. Extract every field you can find from the invoice document and return ONLY a JSON object (no markdown, no commentary) with exactly this shape:
{
  "vendor_name": string | null,
  "vendor_address": string | null,
  "vendor_email": string | null,
  "vendor_phone": string | null,
  "invoice_number": string | null,
  "bill_date": "YYYY-MM-DD" | null,
  "due_date": "YYYY-MM-DD" | null,
  "po_number": string | null,
  "currency": "ISO 4217 code" | null,
  "subtotal": number | null,
  "tax_rate": number | null,
  "tax_amount": number | null,
  "total_amount": number | null,
  "customer": string | null,
  "description": string | null,
  "line_items": [ { "description": string | null, "quantity": number | null, "unit_price": number | null, "amount": number | null, "category": string | null, "class": string | null, "tax_rate": number | null } ]
}
Rules:
- Use null for anything you cannot find — never invent values.
- Dates are YYYY-MM-DD. Amounts are plain numbers, no currency symbols.
- If no line items are visible, return an empty array for line_items.
- Put each visible line item of the invoice into line_items.`;

export async function extractInvoiceFields(
  file: File
): Promise<ExtractedInvoiceData | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (file.type !== "application/pdf" && !file.type.startsWith("image/")) {
    return null;
  }

  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const mime = file.type;

  try {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mime};base64,${base64}`,
                },
              },
              {
                type: "text",
                text: "Extract the invoice fields from this document now.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseExtraction(content);
  } catch {
    return null;
  }
}

// Parse the model's JSON, tolerant of surrounding text/whitespace, and
// coerce every field to its expected type.
function parseExtraction(content: string): ExtractedInvoiceData | null {
  let raw: unknown;
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    raw = JSON.parse(
      start >= 0 && end > start ? content.slice(start, end + 1) : content
    );
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v.replace(/[, ]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const date = (v: unknown): string | null => {
    const s = str(v);
    return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };

  const lineItemsRaw = Array.isArray(o.line_items) ? o.line_items : [];
  const line_items: ExtractedLineItem[] = lineItemsRaw
    .map((li) => {
      if (typeof li !== "object" || li === null) return null;
      const r = li as Record<string, unknown>;
      return {
        description: str(r.description),
        quantity: num(r.quantity),
        unit_price: num(r.unit_price),
        amount: num(r.amount),
        category: str(r.category),
        class: str(r.class),
        tax_rate: num(r.tax_rate),
      };
    })
    .filter((li): li is ExtractedLineItem => li !== null);

  return {
    vendor_name: str(o.vendor_name),
    vendor_address: str(o.vendor_address),
    vendor_email: str(o.vendor_email),
    vendor_phone: str(o.vendor_phone),
    invoice_number: str(o.invoice_number),
    bill_date: date(o.bill_date),
    due_date: date(o.due_date),
    po_number: str(o.po_number),
    currency: str(o.currency)?.toUpperCase() ?? null,
    subtotal: num(o.subtotal),
    tax_rate: num(o.tax_rate),
    tax_amount: num(o.tax_amount),
    total_amount: num(o.total_amount),
    customer: str(o.customer),
    description: str(o.description),
    line_items,
  };
}

// Map the extraction onto the invoices row columns (shared by ingestion
// and re-extraction). Note: source_email (the email sender) is intentionally
// not touched — vendor_email lives inside the extraction jsonb.
export function mapExtractionToInvoice(
  extracted: ExtractedInvoiceData
): Record<string, unknown> {
  return {
    vendor_name: extracted.vendor_name ?? null,
    invoice_number: extracted.invoice_number ?? null,
    bill_date: extracted.bill_date ?? null,
    due_date: extracted.due_date ?? null,
    amount: extracted.total_amount ?? null,
    currency: extracted.currency ?? "USD",
    tax_amount: extracted.tax_amount ?? null,
    extraction: extracted,
  };
}
