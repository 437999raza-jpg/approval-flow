// Minimal, dependency-free PDF writer (Letter size, Helvetica).
// Enough to turn plain text into a real, professional-looking document
// (multi-page, bold headers, size/indent/gray hierarchy, divider rules,
// aligned multi-column table rows, a bordered status badge) that
// accounting systems like QBO accept as an attachment. Deliberately
// small: no font embedding, Latin-1 text only — anything outside that
// range renders as "?". Authored by Araza.

export interface PdfCell {
  text: string;
  x: number; // offset from the line's left edge (MARGIN + indent), points
  bold?: boolean;
  size?: number; // defaults to the line's size
  gray?: number; // defaults to the line's gray
  align?: "left" | "right"; // right-aligns text so it ENDS at x
  maxWidth?: number; // truncate with "..." if the text would exceed this width
}

export interface PdfLine {
  text?: string;
  bold?: boolean;
  size?: number; // defaults to FONT_SIZE
  indent?: number; // points, added to MARGIN
  gray?: number; // 0 (black) .. 1 (white), defaults to 0
  spaceBefore?: number; // extra vertical gap before this line, in points
  rule?: boolean; // draw a horizontal divider instead of text
  cells?: PdfCell[]; // multi-column row; if present, `text` is ignored
  // Bordered rect drawn behind this row. `x`/`width`/`height` are all in
  // points, offset from the line's left edge like a cell.
  box?: { x: number; width: number; height: number; borderGray?: number };
}

const PAGE_W = 612; // Letter, points
const PAGE_H = 792;
const MARGIN = 50;
const FONT_SIZE = 10;

// Standard Helvetica glyph widths (per 1000 units — PDF/AFM convention),
// used for right-aligning table cells (amounts, dates) and sizing the
// status badge box. Approximate for characters not listed.
const CHAR_WIDTH: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667,
  "'": 191, "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333,
  ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556,
  "7": 556, "8": 556, "9": 556,
  ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "[": 278, "\\": 278, "]": 278, "^": 469, _: 556, "`": 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222,
  j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333,
  s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  "{": 334, "|": 260, "}": 334, "~": 584,
};

export function textWidth(text: string, size: number, bold = false): number {
  let units = 0;
  for (const ch of text) units += CHAR_WIDTH[ch] ?? (bold ? 611 : 556);
  return (units / 1000) * size * (bold ? 1.04 : 1); // bold runs slightly wider
}

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
    else out += ASCII_FALLBACK[ch] ?? "?"; // transliterate, else drop to "?"
  }
  return out;
}

// "Smart" punctuation and a few common symbols this font can't render
// (base-14 Helvetica has no Unicode support beyond Latin-1) — mapped to
// a plain-ASCII equivalent instead of falling back to "?".
const ASCII_FALLBACK: Record<string, string> = {
  "—": "-",
  "–": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "→": "->",
  "•": "*",
};

// Truncates with "..." so a table cell can't run into the next column —
// table rows have no line-wrapping, so without this a long description
// would overlap whatever sits to its right.
function truncateToWidth(text: string, maxWidthRaw: number, size: number, bold: boolean): string {
  // The width table is a standard-Helvetica approximation, not exact
  // metrics for whatever actually renders this PDF — shave a small
  // margin off so a near-exact fit doesn't end up touching the next
  // column by a point or two.
  const maxWidth = maxWidthRaw - 4;
  if (textWidth(text, size, bold) <= maxWidth) return text;
  const ellipsis = "...";
  const ellipsisW = textWidth(ellipsis, size, bold);
  let cut = text;
  while (cut.length > 0 && textWidth(cut, size, bold) + ellipsisW > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut.length > 0 ? `${cut}${ellipsis}` : ellipsis;
}

function wrapLine(text: string, size: number): string[] {
  const maxChars = Math.max(20, Math.floor(1000 / size));
  if (text.length <= maxChars) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && cur.length + 1 + word.length > maxChars) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

interface PhysicalGlyphRun {
  x: number;
  text: string;
  bold: boolean;
  size: number;
  gray: number;
}
interface PhysicalRule {
  x: number;
  y: number;
  gray: number;
}
interface PhysicalBox {
  x: number;
  y: number;
  width: number;
  height: number;
  gray: number;
}
interface PhysicalRow {
  y: number;
  runs: PhysicalGlyphRun[];
}

// Expands logical PdfLines (wrapping long text, applying spacing, laying
// out multi-cell rows) into physical positioned content, split into pages
// by actual vertical space.
function layoutPages(allLines: PdfLine[]): {
  rows: PhysicalRow[];
  rules: PhysicalRule[];
  boxes: PhysicalBox[];
}[] {
  const pages: { rows: PhysicalRow[]; rules: PhysicalRule[]; boxes: PhysicalBox[] }[] = [
    { rows: [], rules: [], boxes: [] },
  ];
  let y = PAGE_H - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      pages.push({ rows: [], rules: [], boxes: [] });
      y = PAGE_H - MARGIN;
    }
  };

  for (const line of allLines) {
    const size = line.size ?? FONT_SIZE;
    const lineH = Math.round(size * 1.35);
    const gap = line.spaceBefore ?? 0;
    const x0 = MARGIN + (line.indent ?? 0);

    if (line.rule) {
      ensureSpace(gap + 10);
      y -= gap;
      pages[pages.length - 1].rules.push({ x: x0, y, gray: line.gray ?? 0.75 });
      y -= 12;
      continue;
    }

    if (line.cells) {
      ensureSpace(gap + lineH + (line.box?.height ?? 0));
      y -= gap;
      const page = pages[pages.length - 1];
      if (line.box) {
        page.boxes.push({
          x: x0 + line.box.x,
          y: y - line.box.height + lineH * 0.75,
          width: line.box.width,
          height: line.box.height,
          gray: line.box.borderGray ?? 0.7,
        });
      }
      page.rows.push({
        y,
        runs: line.cells.map((cell) => {
          const cellSize = cell.size ?? size;
          const cellGray = cell.gray ?? line.gray ?? 0;
          const cellBold = !!cell.bold;
          const text = cell.maxWidth
            ? truncateToWidth(cell.text, cell.maxWidth, cellSize, cellBold)
            : cell.text;
          const width = cell.align === "right" ? textWidth(text, cellSize, cellBold) : 0;
          return {
            x: x0 + cell.x - width,
            text,
            bold: cellBold,
            size: cellSize,
            gray: cellGray,
          };
        }),
      });
      y -= lineH;
      continue;
    }

    const wrapped = wrapLine(line.text ?? "", size);
    wrapped.forEach((text, i) => {
      const extra = i === 0 ? gap : 0;
      ensureSpace(lineH + extra);
      y -= extra;
      pages[pages.length - 1].rows.push({
        y,
        runs: [{ x: x0, text, bold: !!line.bold, size, gray: line.gray ?? 0 }],
      });
      y -= lineH;
    });
  }
  return pages;
}

function buildContent(page: { rows: PhysicalRow[]; rules: PhysicalRule[]; boxes: PhysicalBox[] }): string {
  const graphicOps: string[] = [];
  for (const rule of page.rules) {
    graphicOps.push(`${rule.gray} G`, "1 w", `${rule.x} ${rule.y} m`, `${PAGE_W - MARGIN} ${rule.y} l`, "S");
  }
  for (const box of page.boxes) {
    graphicOps.push(`${box.gray} G`, "1 w", `${box.x} ${box.y} ${box.width} ${box.height} re`, "S");
  }

  const textParts: string[] = ["BT"];
  let currentFontKey = "";
  let currentGray = -1;
  for (const row of page.rows) {
    for (const run of row.runs) {
      const fontKey = `${run.bold ? "F2" : "F1"}-${run.size}`;
      if (fontKey !== currentFontKey) {
        textParts.push(`/${run.bold ? "F2" : "F1"} ${run.size} Tf`);
        currentFontKey = fontKey;
      }
      if (run.gray !== currentGray) {
        textParts.push(`${run.gray} g`);
        currentGray = run.gray;
      }
      textParts.push(`1 0 0 1 ${run.x} ${row.y} Tm`);
      textParts.push(`(${escapePdfText(run.text)}) Tj`);
    }
  }
  textParts.push("ET");

  return [...graphicOps, ...textParts].join("\n");
}

// Flattens all lines into pages and serializes a complete PDF document.
export function buildPdf(allLines: PdfLine[]): Buffer {
  const pages = layoutPages(allLines);
  if (pages.length === 0) pages.push({ rows: [], rules: [], boxes: [] });

  // Object references: 1 catalog, 2 pages, 3/4 fonts, then per page:
  // page object + content stream object.
  const layout = pages.map((_, i) => ({
    pageRef: 5 + i * 2,
    contentRef: 6 + i * 2,
    page: pages[i],
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

  for (const p of layout) {
    objects.push({
      ref: p.pageRef,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${p.contentRef} 0 R >>`,
    });
    objects.push({
      ref: p.contentRef,
      stream: buildContent(p.page),
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
