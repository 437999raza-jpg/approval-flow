// Minimal, dependency-free PDF writer (Letter size, Helvetica).
// Enough to turn plain text into a real PDF document (multi-page, bold
// section headers) that accounting systems like QBO accept as an
// attachment. Deliberately small: no font embedding, Latin-1 text only —
// anything outside that range is rendered as "?". Authored by Araza.

export interface PdfLine {
  text: string;
  bold?: boolean;
}

const PAGE_W = 612; // Letter, points
const PAGE_H = 792;
const MARGIN = 50;
const FONT_SIZE = 10;
const LINE_H = 13;
const MAX_CHARS = 100; // conservative wrap width for 10pt Helvetica
const MAX_LINES_PER_PAGE = Math.floor((PAGE_H - MARGIN * 2) / LINE_H);

function escapePdfText(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63;
    if (code === 92) out += "\\\\"; // backslash
    else if (code === 40) out += "\\("; // (
    else if (code === 41) out += "\\)"; // )
    else if (code === 9 || code === 10 || code === 13) out += " ";
    else if (code >= 32 && code <= 126) out += ch; // ASCII
    else if (code >= 160 && code <= 255) out += ch; // Latin-1
    else out += "?"; // everything else (emojis, CJK, …)
  }
  return out;
}

function wrapLine(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && cur.length + 1 + word.length > MAX_CHARS) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function buildContent(lines: PdfLine[]): string {
  const parts: string[] = ["BT"];
  let currentFont = "";
  lines.forEach((line, i) => {
    const y = PAGE_H - MARGIN - i * LINE_H;
    const font = line.bold ? "/F2 10 Tf" : "/F1 10 Tf";
    if (font !== currentFont) {
      parts.push(font);
      currentFont = font;
    }
    parts.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
    parts.push(`(${escapePdfText(line.text)}) Tj`);
  });
  parts.push("ET");
  return parts.join("\n");
}

// Flattens all lines into pages and serializes a complete PDF document.
export function buildPdf(allLines: PdfLine[]): Buffer {
  const pages: PdfLine[][] = [];
  for (let i = 0; i < allLines.length; i += MAX_LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + MAX_LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);

  // Object references: 1 catalog, 2 pages, 3/4 fonts, then per page:
  // page object + content stream object.
  const layout = pages.map((_, i) => ({
    pageRef: 5 + i * 2,
    contentRef: 6 + i * 2,
    lines: pages[i],
  }));

  const objects: { ref: number; body?: string; stream?: string }[] = [
    { ref: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    {
      ref: 2,
      body: `<< /Type /Pages /Kids [${layout
        .map((p) => `${p.pageRef} 0 R`)
        .join(" ")}] /Count ${layout.length} >>`,
    },
    { ref: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    {
      ref: 4,
      body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    },
  ];

  for (const page of layout) {
    objects.push({
      ref: page.pageRef,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${page.contentRef} 0 R >>`,
    });
    objects.push({
      ref: page.contentRef,
      stream: buildContent(page.lines),
    });
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj.ref} 0 obj\n`;
    if (obj.stream !== undefined) {
      const length = Buffer.byteLength(obj.stream, "latin1");
      pdf += `<< /Length ${length} >>\nstream\n${obj.stream}\nendstream\n`;
    } else {
      pdf += `${obj.body}\n`;
    }
    pdf += "endobj\n";
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}
