// Normalize a value for duplicate/supplier matching: lowercase, collapse
// any run of non-alphanumeric characters (bullets "•", dashes, "&", ".",
// …) to a single space, trim. "ONYX•FIRE PROTECTION SERVICES INC." and
// "ONYX FIRE PROTECTION SERVICES INC." are the same vendor for matching
// purposes.
//
// Mirrors the SQL generated column in migration 0031
// (regexp_replace(lower(trim(vendor_name)), '[^a-z0-9]+', ' ', 'g')) so
// app-side and DB-side matching agree. Authored by Araza.
export function normalizeForMatching(
  value: string | null | undefined
): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Project codes look like "2022-58" — the leading token of a QBO project
// name ("2022-58 (Midway Nissan)", "2019-60>Performance Hyundai"). Pull
// that code out of a project name.
function projectCodeFromName(name: string): string {
  // Take everything before the first separator (paren, ">", " - ").
  const cut = name.split(/[>(]| - /)[0]?.trim() ?? "";
  return cut.replace(/[^a-z0-9]+/gi, "");
}

// PO-number → project detection. Suppliers commonly put their job number on
// the PO: a PO like "2022-589-PO-1234" starts with project code "2022-58"
// (2022-58 is how projects start). Given the org's QBO projects and the
// invoice's PO number, return the matching project id, or null. Exact
// prefix wins; longest code wins when several could match.
export function matchProjectFromPoNumber(
  projects: { id: string; name: string }[],
  poNumber: string | null | undefined
): string | null {
  const po = normalizeForMatching(poNumber).replace(/\s+/g, "");
  if (!po) return null;

  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    const code = projectCodeFromName(p.name);
    if (!code) continue;
    // The PO starts with the project code (e.g. po "20225891234"
    // starts with code "202258").
    if (po.startsWith(code)) {
      if (!best || code.length > best.len) {
        best = { id: p.id, len: code.length };
      }
    }
  }
  return best?.id ?? null;
}
