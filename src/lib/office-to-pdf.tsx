// Word/Excel invoices arrive by email sometimes (a vendor's accounting
// software exports one, or an office manager types one up directly) —
// but the entire rest of the pipeline (extractInvoiceFields, the split
// review page count, the document viewer) only ever speaks PDF/image,
// the same way a person can only look at a page, not open a .docx file
// themselves. Rather than teach every one of those a second format,
// convert once, here, at the door: a real PDF comes out, and everything
// downstream needs no changes at all.
//
// Built with @react-pdf/renderer (same as audit-trail.tsx) rather than
// a headless-Chromium HTML render — no new heavy binary dependency, and
// it already runs fine in this serverless environment. This is a
// readable re-typesetting of the content, not a pixel-perfect copy of
// the original Word/Excel layout — fonts, colors and images in the
// source file are not preserved, only the text and table structure.
// Authored by Araza.

import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

export const CONVERTIBLE_OFFICE_TYPES: Record<string, "docx" | "xlsx"> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

// Legacy .doc/.xls (pre-2007 binary formats) are deliberately NOT
// included — mammoth only reads the modern .docx XML format, and a
// binary .doc would silently produce garbage rather than a clear error.
export function officeDocKind(filename: string, contentType: string): "docx" | "xlsx" | null {
  if (CONVERTIBLE_OFFICE_TYPES[contentType]) return CONVERTIBLE_OFFICE_TYPES[contentType];
  const name = filename.toLowerCase();
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".xlsx")) return "xlsx";
  return null;
}

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, color: "#111827", fontFamily: "Helvetica" },
  paragraph: { marginBottom: 8, lineHeight: 1.4 },
  sheetName: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 8, marginTop: 4 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  cell: { flex: 1, padding: 4, fontSize: 8.5 },
  headerRow: { flexDirection: "row", backgroundColor: "#f3f4f6" },
  headerCell: { flex: 1, padding: 4, fontSize: 8.5, fontFamily: "Helvetica-Bold" },
});

// Converts a .docx to a plain-text re-typesetting: mammoth pulls the raw
// text (paragraph breaks preserved, no HTML/styling round-trip needed
// since only the words matter to the extractor and to a human reading
// the preview).
export async function convertDocxToPdf(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const paragraphs = text.split(/\r?\n/).filter((p) => p.trim().length > 0);
    if (paragraphs.length === 0) return null;

    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4" style={styles.page} wrap>
          {paragraphs.map((p, i) => (
            <Text key={i} style={styles.paragraph}>
              {p}
            </Text>
          ))}
        </Page>
      </Document>
    );
    return new Uint8Array(buffer);
  } catch (err) {
    console.error("convertDocxToPdf failed:", err);
    return null;
  }
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "object") {
    // Formula result ({ formula, result }) or rich text ({ richText: [...] }).
    if ("result" in value) return cellText((value as { result: ExcelJS.CellValue }).result);
    if ("richText" in value) {
      return (value as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
    }
    if ("text" in value) return String((value as { text: unknown }).text);
    return "";
  }
  return String(value);
}

// Converts an .xlsx to a simple table re-typesetting: one section per
// worksheet, header row bolded. Values only — formatting, formulas'
// underlying expressions, and merged-cell layout are not preserved,
// same tradeoff as the docx path above.
export async function convertXlsxToPdf(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);

    const sheets = workbook.worksheets.filter((ws) => ws.rowCount > 0);
    if (sheets.length === 0) return null;

    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4" orientation="landscape" style={styles.page} wrap>
          {sheets.map((ws, si) => {
            const rows: string[][] = [];
            ws.eachRow((row) => {
              const cells = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
              rows.push(cells);
            });
            const [header, ...body] = rows;
            return (
              <View key={si}>
                {sheets.length > 1 && <Text style={styles.sheetName}>{ws.name}</Text>}
                {header && (
                  <View style={styles.headerRow}>
                    {header.map((c, ci) => (
                      <Text key={ci} style={styles.headerCell}>
                        {c}
                      </Text>
                    ))}
                  </View>
                )}
                {body.map((r, ri) => (
                  <View key={ri} style={styles.row} wrap={false}>
                    {r.map((c, ci) => (
                      <Text key={ci} style={styles.cell}>
                        {c}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          })}
        </Page>
      </Document>
    );
    return new Uint8Array(buffer);
  } catch (err) {
    console.error("convertXlsxToPdf failed:", err);
    return null;
  }
}

export async function convertOfficeDocToPdf(
  bytes: Uint8Array,
  filename: string,
  contentType: string
): Promise<Uint8Array | null> {
  const kind = officeDocKind(filename, contentType);
  if (kind === "docx") return convertDocxToPdf(bytes);
  if (kind === "xlsx") return convertXlsxToPdf(bytes);
  return null;
}
