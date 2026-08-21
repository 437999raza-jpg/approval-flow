// Multi-page upload splitting: a single uploaded PDF might be (a) one
// invoice plus supporting pages (PO, packing slip, T&Cs) — handled fine
// today, the whole file becomes one invoice's document — or (b) several
// completely separate invoices stapled into one file, which today would
// silently become just one invoice and drop the rest. This module
// classifies which case a multi-page PDF is, and can carve a page range
// out into its own standalone PDF once a human confirms the split.
// Authored by Araza.

import * as mupdf from "mupdf";

const MAX_CLASSIFY_PAGES = 20; // whole-document boundary detection, not
// the single-invoice extraction's tighter MAX_PDF_PAGES cap.

export interface PageGroup {
  pages: number[]; // 1-indexed, in order
  vendorHint: string | null;
  invoiceNumberHint: string | null;
}

const CLASSIFY_SYSTEM_PROMPT = `You are looking at every page of one uploaded file, as images in page order. Determine whether this file contains ONE invoice (optionally followed by supporting pages like a purchase order, packing slip, contract, or terms and conditions for that same invoice) or MULTIPLE SEPARATE invoices stapled together.

A new invoice typically starts with its own vendor letterhead/logo, its own "Invoice #"/"Bill #", and its own totals — a supporting page for the SAME invoice usually has neither.

Group every page into exactly one group, covering all pages, in ascending page order. Return ONLY a JSON object, no markdown, no commentary:
{
  "groups": [
    { "pages": [1,2], "vendor_name": string | null, "invoice_number": string | null },
    { "pages": [3], "vendor_name": string | null, "invoice_number": string | null }
  ]
}
If the whole file is one invoice (with or without supporting pages), return a single group covering every page.`;

// Renders up to MAX_CLASSIFY_PAGES of a PDF to PNG data URLs, for either
// classification or building thumbnails in the split-review UI.
export function renderPdfPagesToPngDataUrls(
  bytes: Uint8Array,
  maxPages = MAX_CLASSIFY_PAGES
): { pageCount: number; images: string[] } {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pageCount = doc.countPages();
    const images: string[] = [];
    for (let i = 0; i < Math.min(pageCount, maxPages); i++) {
      const page = doc.loadPage(i);
      const pix = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, true, true);
      const png = pix.asPNG();
      images.push(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    }
    return { pageCount, images };
  } finally {
    doc.destroy();
  }
}

// Best-effort: null on any failure (missing API key, bad response, etc.)
// — the caller should treat null as "assume single invoice" so a
// classification hiccup never blocks an upload outright.
export async function classifyMultiPageInvoice(
  bytes: Uint8Array
): Promise<PageGroup[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  try {
    const { pageCount, images } = renderPdfPagesToPngDataUrls(bytes);
    if (pageCount <= 1) return [{ pages: [1], vendorHint: null, invoiceNumberHint: null }];

    const model = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              ...images.map((url) => ({ type: "image_url", image_url: { url } })),
              { type: "text", text: `This file has ${pageCount} page(s), shown above in order. Group them now.` },
            ],
          },
        ],
      }),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) return null;

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const raw = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
    const rawGroups = Array.isArray(raw?.groups) ? raw.groups : null;
    if (!rawGroups || rawGroups.length === 0) return null;

    const seen = new Set<number>();
    const groups: PageGroup[] = [];
    for (const g of rawGroups) {
      const pages = Array.isArray(g?.pages)
        ? g.pages
            .map((p: unknown) => Number(p))
            .filter((p: number) => Number.isInteger(p) && p >= 1 && p <= pageCount)
        : [];
      if (pages.length === 0) continue;
      for (const p of pages) seen.add(p);
      groups.push({
        pages,
        vendorHint: typeof g.vendor_name === "string" ? g.vendor_name : null,
        invoiceNumberHint: typeof g.invoice_number === "string" ? g.invoice_number : null,
      });
    }
    // Sanity check: every page must be accounted for exactly once, and
    // groups must be non-overlapping — otherwise this is untrustworthy,
    // fall back to "assume single invoice" rather than act on a bad split.
    if (seen.size !== pageCount) return null;
    const totalAssigned = groups.reduce((n, g) => n + g.pages.length, 0);
    if (totalAssigned !== pageCount) return null;

    return groups;
  } catch {
    return null;
  }
}

// Carves the given 1-indexed pages out of a PDF into a new standalone
// PDF (used once a split is confirmed, to create each invoice's own
// document from the original multi-invoice upload).
export function extractPdfPageRange(bytes: Uint8Array, pages: number[]): Uint8Array {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF();
    if (!pdf) throw new Error("Not a PDF document");
    pdf.rearrangePages(pages.map((p) => p - 1));
    return pdf.saveToBuffer().asUint8Array();
  } finally {
    doc.destroy();
  }
}
