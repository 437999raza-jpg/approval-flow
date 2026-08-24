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
