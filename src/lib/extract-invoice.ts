import Anthropic from "@anthropic-ai/sdk";

export interface ExtractedInvoiceFields {
  vendor_name: string | null;
  invoice_number: string | null;
  amount: number | null;
  currency: string | null;
  due_date: string | null;
}

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: "record_invoice_fields",
  description:
    "Record the vendor name, invoice number, total amount, currency, and due date found on an invoice document.",
  input_schema: {
    type: "object",
    properties: {
      vendor_name: {
        type: ["string", "null"],
        description: "The company or person being paid.",
      },
      invoice_number: {
        type: ["string", "null"],
        description: "The invoice/reference number as printed on the document.",
      },
      amount: {
        type: ["number", "null"],
        description: "The total amount due, as a plain number with no currency symbol.",
      },
      currency: {
        type: ["string", "null"],
        description: "ISO 4217 3-letter currency code, e.g. USD, EUR, GBP.",
      },
      due_date: {
        type: ["string", "null"],
        description: "Payment due date in YYYY-MM-DD format.",
      },
    },
    required: ["vendor_name", "invoice_number", "amount", "currency", "due_date"],
    additionalProperties: false,
  },
  strict: true,
};

// Best-effort field extraction: returns null (never throws) on any failure,
// so a flaky/unavailable extraction never blocks invoice ingestion.
export async function extractInvoiceFields(
  file: File
): Promise<ExtractedInvoiceFields | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (file.type !== "application/pdf" && !file.type.startsWith("image/")) return null;

  try {
    const client = new Anthropic();
    const data = Buffer.from(await file.arrayBuffer()).toString("base64");

    const documentBlock: Anthropic.ContentBlockParam =
      file.type === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data },
          }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: file.type as "image/png" | "image/jpeg" | "image/webp",
              data,
            },
          };

    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: "tool", name: "record_invoice_fields" },
      messages: [
        {
          role: "user",
          content: [
            documentBlock,
            {
              type: "text",
              text: "Extract the vendor name, invoice number, total amount, currency, and due date from this invoice. Use null for any field you can't find.",
            },
          ],
        },
      ],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    return (toolUse?.input as ExtractedInvoiceFields) ?? null;
  } catch {
    return null;
  }
}
