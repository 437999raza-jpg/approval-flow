// Vendor statement line extraction via OpenRouter — same architecture as
// extract-invoice.ts (PDF pages rendered to PNG with mupdf, sent to a
// vision model, strict JSON back), but for a different document shape: a
// statement is just a flat list of invoice numbers/dates/amounts, not a
// single document with subtotal/tax/line-item logic.
//
// Env:
//   OPENROUTER_API_KEY  — required for extraction (best-effort without it)
//   OPENROUTER_MODEL    — optional, e.g. "anthropic/claude-sonnet-4.5"
//
// Best-effort: any failure resolves to null rather than blocking the upload.
// Authored by Araza.

import * as mupdf from "mupdf";
import { recordLlmUsage } from "@/lib/llm-usage";

export interface ExtractedStatementLine {
  invoice_number: string;
  date: string | null; // YYYY-MM-DD
  amount: number | null;
}

export interface ExtractedStatement {
  statement_date: string | null; // YYYY-MM-DD, the date printed on the statement itself
  closing_balance: number | null; // the statement's own printed outstanding/total-due balance
  lines: ExtractedStatementLine[];
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const MAX_PDF_PAGES = 6; // statements run longer than a single invoice

const SYSTEM_PROMPT = `You are a vendor statement data extraction engine. A statement lists the invoices a vendor has billed a customer for, usually one per row with an invoice number, a date, and an amount, plus a statement date and an outstanding balance printed near the top. Return ONLY a JSON object (no markdown, no commentary) with exactly this shape:
{
  "statement_date": "YYYY-MM-DD" | null,
  "closing_balance": number | null,
  "lines": [ { "invoice_number": string, "date": "YYYY-MM-DD" | null, "amount": number | null } ]
}
Rules:
- statement_date is the single date the statement itself was issued (often near "Statement Date" or the account/page header) — not any individual invoice's date.
- closing_balance is the total outstanding balance the statement says is owed (often labeled "Balance Due", "Total Due", "Amount Due", or similar) — a single number, not a per-line amount.
- One entry per invoice line on the statement — skip subtotal/balance/total rows, they are not invoices.
- invoice_number is required on a line — skip a row if you cannot find one.
- Dates are YYYY-MM-DD. Amounts are plain numbers, no currency symbols.
- Use null for anything you cannot find — never invent values.`;

type ContentPart =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "text"; text: string };

export async function extractStatementLines(
  file: File,
  organizationId?: string
): Promise<ExtractedStatement | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (file.type !== "application/pdf" && !file.type.startsWith("image/")) {
    return null;
  }

  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  try {
    const content: ContentPart[] = [];

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
      } finally {
        doc.destroy();
      }
      if (content.length === 0) return null;
    } else {
      const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      content.push({
        type: "image_url",
        image_url: { url: `data:${file.type};base64,${base64}` },
      });
    }

    content.push({
      type: "text",
      text: "Extract every invoice line from this vendor statement now.",
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
          max_tokens: 4096,
          response_format: { type: "json_object" },
          usage: { include: true },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content },
          ],
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `extractStatementLines: OpenRouter ${response.status}: ${text.slice(0, 500)}`
      );
      return null;
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
      };
    };
    if (organizationId) {
      await recordLlmUsage(organizationId, "statement", model, body.usage);
    }
    const contentText = body.choices?.[0]?.message?.content;
    if (!contentText) {
      console.error("extractStatementLines: OpenRouter returned no content");
      return null;
    }

    const parsed = parseExtraction(contentText);
    if (!parsed) {
      console.error(
        `extractStatementLines: could not parse model output (${contentText.length} chars): ${contentText.slice(0, 300)}`
      );
    }
    return parsed;
  } catch (err) {
    console.error(
      "extractStatementLines error:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

function parseExtraction(content: string): ExtractedStatement | null {
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

  const linesRaw = Array.isArray(o.lines) ? o.lines : [];
  const lines = linesRaw
    .map((l) => {
      if (typeof l !== "object" || l === null) return null;
      const r = l as Record<string, unknown>;
      const invoice_number = str(r.invoice_number);
      if (!invoice_number) return null;
      return {
        invoice_number,
        date: date(r.date),
        amount: num(r.amount),
      };
    })
    .filter((l): l is ExtractedStatementLine => l !== null);

  return {
    statement_date: date(o.statement_date),
    closing_balance: num(o.closing_balance),
    lines,
  };
}
