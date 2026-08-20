import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Report runner: executes a saved report config against the caller's
// visible invoices (RLS scopes the query, so admins see everything and
// members only their workflow-covered projects). Authored by Araza.

export interface ReportFilters {
  status?: string;
  vendor?: string; // case-insensitive contains
  project_id?: string;
  amount_over?: number;
  amount_under?: number;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

export interface ReportConfig {
  metric: "count" | "amount" | "tax";
  groupBy: "none" | "month" | "vendor" | "status" | "project";
  filters: ReportFilters;
}

export interface ReportRow {
  key: string;
  count: number;
  amount: number;
  tax: number;
}

export interface ReportResult {
  rows: ReportRow[];
  totals: ReportRow;
  metric: ReportConfig["metric"];
  groupBy: ReportConfig["groupBy"];
}

export async function runReport(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  config: ReportConfig
): Promise<ReportResult> {
  const { data: invoices } = await supabase
    .from("invoices")
    .select(
      "id, status, vendor_name, project_id, amount, tax_amount, created_at"
    )
    .eq("organization_id", organizationId);

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name")
    .eq("organization_id", organizationId);
  const projectName = new Map(
    (projects ?? []).map((p) => [p.id, p.name])
  );

  const f = config.filters;
  const fromMs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toMs = f.to ? new Date(`${f.to}T23:59:59`).getTime() : null;

  const list = (invoices ?? []).filter((i) => {
    if (f.status && i.status !== f.status) return false;
    if (
      f.vendor &&
      !(i.vendor_name ?? "").toLowerCase().includes(f.vendor.toLowerCase())
    ) {
      return false;
    }
    if (f.project_id && i.project_id !== f.project_id) return false;
    if (f.amount_over != null && (i.amount ?? 0) < f.amount_over) return false;
    if (f.amount_under != null && (i.amount ?? 0) > f.amount_under) return false;
    const created = new Date(i.created_at).getTime();
    if (fromMs != null && created < fromMs) return false;
    if (toMs != null && created > toMs) return false;
    return true;
  });

  const keyOf = (i: (typeof list)[number]): string => {
    switch (config.groupBy) {
      case "month":
        return i.created_at.slice(0, 7); // YYYY-MM
      case "vendor":
        return i.vendor_name ?? "Unknown";
      case "status":
        return i.status;
      case "project":
        return i.project_id
          ? (projectName.get(i.project_id) ?? "Unknown")
          : "No project";
      default:
        return "All";
    }
  };

  const rows = new Map<string, ReportRow>();
  const totals: ReportRow = { key: "Total", count: 0, amount: 0, tax: 0 };

  for (const i of list) {
    const key = keyOf(i);
    const row = rows.get(key) ?? { key, count: 0, amount: 0, tax: 0 };
    row.count += 1;
    row.amount += i.amount ?? 0;
    row.tax += i.tax_amount ?? 0;
    rows.set(key, row);

    totals.count += 1;
    totals.amount += i.amount ?? 0;
    totals.tax += i.tax_amount ?? 0;
  }

  return {
    rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    totals,
    metric: config.metric,
    groupBy: config.groupBy,
  };
}
