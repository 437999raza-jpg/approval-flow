// Robust invoice extraction via OpenRouter (model-agnostic).
//
// Sends the invoice document to the configured OpenRouter model and asks
// for a strict JSON object covering far more than the basic fields — line
// items, tax, subtotal, PO number, vendor contact details, customer,
// description — so the Bill panel and routing engine have real data.
//
// PDFs are rendered to PNG pages with mupdf (WASM, no native deps) because
// OpenRouter vision models accept images, not raw PDFs. The OCR text is
// also included as prompt context for extra robustness.
//
// Env:
//   OPENROUTER_API_KEY  — required for extraction (best-effort without it)
//   OPENROUTER_MODEL    — optional, e.g. "anthropic/claude-sonnet-4.5"
//
// Best-effort: any failure resolves to null rather than blocking ingestion.
// Authored by Araza.

import * as mupdf from "mupdf";
import { computeLineItemTotals } from "@/lib/invoice-totals";

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
const MAX_PDF_PAGES = 3;

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
- Put each visible line item of the invoice into line_items.
- The document may have multiple pages (the invoice plus change orders or
  supporting pages). Include the invoice's line items AND any change-order
  line items as separate rows in line_items — never duplicate the same item
  across pages. The printed total_amount covers the whole invoice,
  including change orders.`;

type ContentPart =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "text"; text: string };

export async function extractInvoiceFields(
  file: File
): Promise<ExtractedInvoiceData | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (file.type !== "application/pdf" && !file.type.startsWith("image/")) {
    return null;
  }

  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  try {
    const content: ContentPart[] = [];
    let textContext = "";

    if (file.type === "application/pdf") {
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = mupdf.Document.openDocument(data, "application/pdf");
      try {
        const pageCount = doc.countPages();
        for (let i = 0; i < Math.min(pageCount, MAX_PDF_PAGES); i++) {
          const page = doc.loadPage(i);
          const pix = page.toPixmap(
            mupdf.Matrix.scale(2, 2),
            mupdf.ColorSpace.DeviceRGB,
            true,
            true
          );
          const png = pix.asPNG();
          content.push({
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
            },
          });
        }
        try {
          const st = doc
            .loadPage(0)
            .toStructuredText("preserve-whitespace");
          textContext = st.asText().slice(0, 4000);
        } catch {
          // text extraction is a bonus; images carry the content
        }
      } finally {
        doc.destroy();
      }
      if (content.length === 0 && !textContext) return null;
    } else {
      const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      content.push({
        type: "image_url",
        image_url: { url: `data:${file.type};base64,${base64}` },
      });
    }

    content.push({
      type: "text",
      text:
        "Extract the invoice fields from this document now." +
        (textContext
          ? `\n\nOCR text for reference (may contain errors):\n${textContext}`
          : ""),
    });

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
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
            { role: "user", content },
          ],
        }),
      }
    );

    if (!response.ok) return null;

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const contentText = body.choices?.[0]?.message?.content;
    if (!contentText) return null;

    return parseExtraction(contentText);
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

// The invoice's real amount and tax: derived from the line items we
// actually picked up (amount × each line's own tax rate%, blank rate =
// no tax for that line) — not whatever numbers the document prints as
// "Tax"/"Total". A document's printed totals can be wrong (bad OCR, a
// math error on the document itself, or a tampered/faked total that
// doesn't match its own line items) while the line items are what the
// Bill panel and the approver actually review. Falls back to the
// extracted whole-document totals only when no line item amounts were
// found to sum.
export function computeInvoiceTotals(extracted: ExtractedInvoiceData): {
  amount: number | null;
  tax_amount: number | null;
} {
  const validLineItems = extracted.line_items.filter((li) => li.amount != null);
  if (validLineItems.length === 0) {
    return {
      amount: extracted.total_amount ?? null,
      tax_amount: extracted.tax_amount ?? null,
    };
  }
  const { tax, total } = computeLineItemTotals(validLineItems);
  return { amount: total, tax_amount: tax };
}

// Map the extraction onto the invoices row columns (shared by ingestion
// and re-extraction). Note: source_email (the email sender) is intentionally
// not touched — vendor_email lives inside the extraction jsonb.
export function mapExtractionToInvoice(
  extracted: ExtractedInvoiceData
): Record<string, unknown> {
  const { amount, tax_amount } = computeInvoiceTotals(extracted);

  // Same "document total wins" reconciliation as ingest (invoices.ts): when
  // line items exist and disagree with the printed total, the printed total
  // is used and a note is recorded; when the printed total couldn't be read
  // at all, say the amount was derived from line items. Re-extract must
  // behave exactly like first-time ingest, or the hard rule silently breaks.
  const hasLineItems = extracted.line_items.length > 0;
  const printedTotal = extracted.total_amount ?? null;
  let finalAmount = hasLineItems ? amount : printedTotal;
  let finalTax = hasLineItems ? tax_amount : (extracted.tax_amount ?? null);
  let totalsNote: string | null = null;
  if (hasLineItems && amount != null) {
    if (printedTotal != null && Math.abs(printedTotal - amount) > 0.01) {
      finalAmount = printedTotal;
      if (extracted.tax_amount != null) finalTax = extracted.tax_amount;
      totalsNote = `Document total ${printedTotal.toFixed(2)} differs from line items (${amount.toFixed(2)}). The document total was used.`;
    } else if (printedTotal == null) {
      totalsNote = `The document's printed total could not be read — the amount shown (${amount.toFixed(2)}) was derived from the line items. Please verify it against the invoice.`;
    }
  }

  return {
    vendor_name: extracted.vendor_name ?? null,
    invoice_number: extracted.invoice_number ?? null,
    bill_date: extracted.bill_date ?? null,
    due_date: extracted.due_date ?? null,
    amount: finalAmount,
    currency: extracted.currency ?? "USD",
    tax_amount: finalTax,
    totals_note: totalsNote,
    extraction: extracted,
  };
}
