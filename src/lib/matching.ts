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
