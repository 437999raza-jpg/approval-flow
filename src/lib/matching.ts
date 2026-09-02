import { matchProject } from "@/lib/project-matching";

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

// Superseded by matchProject in src/lib/project-matching.ts, which
// handles conventions other than Fluid's "YYYY-NN (Name)", looks beyond
// the PO number, and returns a confidence instead of a bare id. Kept as
// a thin delegate so nothing depending on the old signature breaks.
export function matchProjectFromPoNumber(
  projects: { id: string; name: string }[],
  poNumber: string | null | undefined
): string | null {
  const match = matchProject(projects, { poNumber });
  return match && match.confidence !== "low" ? match.projectId : null;
}

