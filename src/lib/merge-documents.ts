import * as mupdf from "mupdf";

// Merge PDF/image files into ONE PDF, in order — exactly what a human does
// in Preview when a client emails an invoice plus supporting files (a
// backup, a certificate copy): merge them into one document with the
// invoice pages first, so the app sees one invoice instead of three.
//
// PDFs are grafted page-by-page; images are converted to a single PDF page
// each. Returns the merged PDF bytes, or null if anything fails (callers
// fall back to ingesting the files separately).
export async function mergeDocuments(
  files: { name: string; type: string; bytes: Uint8Array }[]
): Promise<Uint8Array | null> {
  try {
    const out = new mupdf.PDFDocument();

    for (const f of files) {
      let doc;
      if (f.type.startsWith("image/")) {
        // Image → single-page PDF via a writer device.
        const img = new mupdf.Image(f.bytes);
        const w = img.getWidth();
        const h = img.getHeight();
        const buf = new mupdf.Buffer();
        const writer = new mupdf.DocumentWriter(buf, "pdf", "");
        const dev = writer.beginPage([0, 0, w, h]);
        dev.fillImage(img, mupdf.Matrix.scale(1, 1), 1);
        writer.endPage();
        writer.close();
        doc = mupdf.Document.openDocument(
          new Uint8Array(buf.asUint8Array()),
          "application/pdf"
        );
      } else {
        doc = mupdf.Document.openDocument(f.bytes, "application/pdf");
      }

      try {
        const srcPdf = doc.asPDF();
        if (!srcPdf) continue;
        const n = srcPdf.countPages();
        for (let i = 0; i < n; i++) {
          out.graftPage(out.countPages(), srcPdf, i);
        }
      } finally {
        doc.destroy();
      }
    }

    const bytes = out.saveToBuffer().asUint8Array();
    // Copy off the wasm-owned buffer so the result is a plain, GC-able
    // ArrayBuffer-backed array.
    return bytes.length > 0 ? new Uint8Array(bytes) : null;
  } catch (err) {
    console.error("mergeDocuments failed:", err);
    return null;
  }
}

// Rebuild a PDF keeping only the listed pages, in the given order (1-based
// page numbers). Omitting a page DELETES it — the list may be any non-empty
// subset of 1..N in any order, so this supports both reordering and
// deleting unwanted pages (e.g. trimming a 10-page merged scan down to the
// 2 real invoice pages). Returns the rebuilt PDF bytes, or null if the
// page list isn't valid (empty, duplicated, or out of range).
export async function reorderPdfPages(
  bytes: Uint8Array,
  order: number[]
): Promise<Uint8Array | null> {
  try {
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    try {
      const pdf = doc.asPDF();
      if (!pdf) return null;
      const n = pdf.countPages();
      const valid =
        order.length >= 1 &&
        new Set(order).size === order.length &&
        order.every((p) => Number.isInteger(p) && p >= 1 && p <= n);
      if (!valid) return null;

      const out = new mupdf.PDFDocument();
      for (const page of order) {
        out.graftPage(out.countPages(), pdf, page - 1);
      }
      const outBytes = out.saveToBuffer().asUint8Array();
      return outBytes.length > 0 ? new Uint8Array(outBytes) : null;
    } finally {
      doc.destroy();
    }
  } catch (err) {
    console.error("reorderPdfPages failed:", err);
    return null;
  }
}

// Page count of a PDF (used by the Reorder pages UI).
export function pdfPageCount(bytes: Uint8Array): number {
  try {
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    try {
      return doc.countPages();
    } finally {
      doc.destroy();
    }
  } catch (err) {
    console.error("pdfPageCount failed:", err);
    return 0;
  }
}

// Pixel dimensions of an image attachment (used to spot signature/logo
// strips — tiny or extremely wide-and-short images — so they don't become
// junk invoices). Returns null when the bytes aren't a decodable image.
export function imageDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  try {
    const img = new mupdf.Image(bytes);
    return { width: img.getWidth(), height: img.getHeight() };
  } catch {
    return null;
  }
}
