import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { SubmitButton } from "@/components/SubmitButton";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { FilterCombobox } from "@/components/FilterCombobox";
import { runReport, type ReportConfig } from "@/lib/reports";
import {
  buildInvoiceListReport,
  REPORT_COLUMNS,
  DEFAULT_REPORT_COLUMNS,
  type ReportColumnId,
} from "@/lib/invoice-list-report";
import { getCachedMemberRoster } from "@/lib/org-cache";
import { TrialBanner } from "@/components/TrialBanner";

const FORM_ID = "report-builder-form";
// Prepended to every searchable person/project dropdown below so there's
// an easy, typeable way back to "no filter" — Combobox (built for the
// Bill panel's always-has-a-value fields) reverts to the last real pick
// if you just clear the text, so a literal option is what makes "Any"
// reachable by typing rather than requiring a separate clear button.
const ANY_OPTION = { label: "Any", value: "" };

// ---------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------

// Same builder form creates a new report or, when a report_id is present,
// updates the existing one in place — reported: the only way to fix a
// mistake or tweak a filter used to be deleting the report and rebuilding
// it from scratch.
async function saveReport(orgId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const metric = String(formData.get("metric") ?? "count") as
    | "count"
    | "amount"
    | "tax";
  const groupBy = String(formData.get("group_by") ?? "none") as
    | "none"
    | "month"
    | "vendor"
    | "status"
    | "project";

  const num = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const date = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  };
  const text = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    return raw || undefined;
  };

  const columns = formData.getAll("columns").map(String);

  const config: ReportConfig = {
    metric,
    groupBy,
    filters: {
      status: text("f_status"),
      vendor: text("f_vendor"),
      project_id: text("f_project"),
      amount_over: num("f_amount_over"),
      amount_under: num("f_amount_under"),
      from: date("f_from"),
      to: date("f_to"),
      waiting_for_user_id: text("f_waiting_for"),
      approved_by_user_id: text("f_approved_by"),
      submitted_by_user_id: text("f_requester"),
    },
    columns,
  };

  const reportId = String(formData.get("report_id") ?? "").trim() || null;

  if (reportId) {
    await supabase
      .from("saved_reports")
      .update({ name, config: config as unknown as Record<string, unknown> })
      .eq("id", reportId)
      .eq("organization_id", orgId);
    revalidatePath("/reports");
    redirect(`/reports?run=${reportId}`);
  }

  const { data: created } = await supabase
    .from("saved_reports")
    .insert({
      organization_id: orgId,
      name,
      config: config as unknown as Record<string, unknown>,
      created_by: user.id,
    })
    .select("id")
    .single();

  revalidatePath("/reports");
  if (created?.id) redirect(`/reports?run=${created.id}`);
}

async function deleteReport(reportId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("saved_reports").delete().eq("id", reportId);

  revalidatePath("/reports");
}

// ---------------------------------------------------------------------
// Plain-English summary of a saved report's config — the card-grid
// description text (see the ApprovalMax "Request reports" screen this
// mirrors: each card names its own filters, e.g. "Status is On approval").
// ---------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  on_review: "On review",
  on_approval: "On approval",
  approved: "Approved",
  cancelled: "Cancelled",
  rejected: "Rejected",
  on_hold: "On hold",
};
const GROUP_LABELS: Record<ReportConfig["groupBy"], string> = {
  none: "",
  month: "Month",
  vendor: "Vendor",
  status: "Status",
  project: "Project",
};

function describeReportConfig(
  config: ReportConfig,
  projectNameById: Map<string, string>,
  memberNameById: Map<string, string>
): string[] {
  const f = config.filters;
  const lines: string[] = [];
  if (f.status) lines.push(`Status is ${STATUS_LABELS[f.status] ?? f.status}`);
  if (f.vendor) lines.push(`Vendor contains "${f.vendor}"`);
  if (f.project_id) lines.push(`Customer is ${projectNameById.get(f.project_id) ?? "Unknown"}`);
  if (f.waiting_for_user_id) {
    lines.push(`Waiting for ${memberNameById.get(f.waiting_for_user_id) ?? "Team member"}`);
  }
  if (f.approved_by_user_id) {
    lines.push(`Approved by ${memberNameById.get(f.approved_by_user_id) ?? "Team member"}`);
  }
  if (f.submitted_by_user_id) {
    lines.push(`Requester is ${memberNameById.get(f.submitted_by_user_id) ?? "Team member"}`);
  }
  if (f.amount_over != null) lines.push(`Amount over ${f.amount_over}`);
  if (f.amount_under != null) lines.push(`Amount under ${f.amount_under}`);
  if (f.from || f.to) lines.push(`Date from ${f.from ?? "any"} to ${f.to ?? "any"}`);
  if (config.groupBy !== "none") lines.push(`Grouped by ${GROUP_LABELS[config.groupBy]}`);
  if (config.metric !== "count") {
    lines.push(`Metric: ${config.metric === "amount" ? "Total amount" : "Total tax"}`);
  }
  return lines.length > 0 ? lines : ["All invoices — no filters"];
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: { run?: string; edit?: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The shared layout ((app)/layout.tsx) already redirects to /dashboard
  // when there's no org — this is only a type-narrowing guard.
  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");

  const [{ data: trialOrgRow }, { data: reports }, { data: projects }, { memberUserIds, profileRows }] =
    await Promise.all([
      supabase.from("organizations").select("plan, trial_ends_at").eq("id", org.id).single(),
      supabase
        .from("saved_reports")
        .select("*")
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("projects")
        .select("id, name")
        .eq("organization_id", org.id)
        .eq("active", true)
        .order("name", { ascending: true }),
      getCachedMemberRoster(org.id),
    ]);
  const memberNameById = new Map(
    (profileRows ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
  );
  const memberOptions = memberUserIds
    .map((id) => ({ id, label: memberNameById.get(id) ?? "Team member" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const projectNameById = new Map((projects ?? []).map((p) => [p.id, p.name]));

  const projectComboOptions = [
    ANY_OPTION,
    ...(projects ?? []).map((p) => ({ label: p.name, value: p.id })),
  ];
  const memberComboOptions = [
    ANY_OPTION,
    ...memberOptions.map((m) => ({ label: m.label, value: m.id })),
  ];

  // Run the requested report (if any) — RLS on `invoices` already scopes
  // every query below to what the caller can see (admins see everything;
  // a "user" role member only their workflow-covered projects), the same
  // way every other invoice query in this app is scoped. No extra
  // filtering needed here for that.
  const runningReport = searchParams.run
    ? (reports ?? []).find((r) => r.id === searchParams.run)
    : undefined;
  const runningConfig = runningReport
    ? (runningReport.config as unknown as ReportConfig)
    : null;
  const result = runningConfig
    ? await runReport(supabase, org.id, runningConfig)
    : null;
  const runningFilters = runningConfig?.filters ?? null;
  const activeColumns = (runningConfig?.columns?.length
    ? runningConfig.columns
    : DEFAULT_REPORT_COLUMNS) as ReportColumnId[];
  const listRows = runningFilters
    ? await buildInvoiceListReport(supabase, org.id, runningFilters)
    : null;
  const listIds = (listRows ?? []).map((r) => r.id);
  const exportQs = (f: typeof runningFilters) => {
    const params = new URLSearchParams();
    if (f) {
      if (f.status) params.set("f_status", f.status);
      if (f.vendor) params.set("f_vendor", f.vendor);
      if (f.project_id) params.set("f_project", f.project_id);
      if (f.amount_over != null) params.set("f_amount_over", String(f.amount_over));
      if (f.amount_under != null) params.set("f_amount_under", String(f.amount_under));
      if (f.from) params.set("f_from", f.from);
      if (f.to) params.set("f_to", f.to);
      if (f.waiting_for_user_id) params.set("f_waiting_for", f.waiting_for_user_id);
      if (f.approved_by_user_id) params.set("f_approved_by", f.approved_by_user_id);
      if (f.submitted_by_user_id) params.set("f_requester", f.submitted_by_user_id);
    }
    params.set("cols", activeColumns.join(","));
    return `?${params.toString()}`;
  };
  const idsQs = listIds.length > 0 ? `?ids=${listIds.join(",")}` : "";

  // Editing an existing report loads its saved config into the builder
  // form below instead of starting blank.
  const editingReport = searchParams.edit
    ? (reports ?? []).find((r) => r.id === searchParams.edit)
    : undefined;
  const editingConfig = editingReport
    ? (editingReport.config as unknown as ReportConfig)
    : null;
  const ef = editingConfig?.filters;
  const editingColumns = (editingConfig?.columns?.length
    ? editingConfig.columns
    : DEFAULT_REPORT_COLUMNS) as ReportColumnId[];

  const fmtNum = (n: number) =>
    n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const fmtAge = (days: number) => (days <= 0 ? "Today" : `${days}d`);

  const inputCls =
    "rounded-md border border-slate-300 px-2.5 py-2 text-sm focus:border-blue-500 focus:outline-none";
  const labelCls = "block text-[10px] font-semibold uppercase tracking-wide text-slate-400";

  return (
    <main className="mx-auto w-full max-w-5xl p-8">
      <TrialBanner plan={trialOrgRow?.plan ?? null} trialEndsAt={trialOrgRow?.trial_ends_at ?? null} />
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-brand-ink">Reports</h1>
          <p className="mt-1 text-sm text-slate-500">
            Build and save your own reports. Every report runs against
            what you can see (admins see everything; members see their
            workflow-covered projects).
          </p>

          {/* Builder */}
          <form
            key={editingReport?.id ?? "new"}
            id={FORM_ID}
            action={saveReport.bind(null, org.id)}
            className="mt-4 rounded-lg border border-slate-200 bg-white shadow-elevation-1 p-4"
          >
            {editingReport && (
              <input type="hidden" name="report_id" value={editingReport.id} />
            )}
            {editingReport && (
              <div className="mb-3 flex items-center justify-between rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span>
                  Editing <strong>{editingReport.name}</strong>
                </span>
                <Link href="/reports" className="font-medium hover:underline">
                  Cancel, start a new report
                </Link>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-52 flex-1">
                <span className={labelCls}>Report name</span>
                <input
                  name="name"
                  required
                  defaultValue={editingReport?.name ?? ""}
                  placeholder="e.g. Approved invoices by vendor"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Metric</span>
                <select name="metric" defaultValue={editingConfig?.metric ?? "count"} className={inputCls}>
                  <option value="count">Count</option>
                  <option value="amount">Total amount</option>
                  <option value="tax">Total tax</option>
                </select>
              </div>
              <div>
                <span className={labelCls}>Group by</span>
                <select name="group_by" defaultValue={editingConfig?.groupBy ?? "none"} className={inputCls}>
                  <option value="none">No grouping</option>
                  <option value="month">Month</option>
                  <option value="vendor">Vendor</option>
                  <option value="status">Status</option>
                  <option value="project">Project</option>
                </select>
              </div>
            </div>

            <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Filters
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-4">
              <div>
                <span className={labelCls}>Status</span>
                <select name="f_status" defaultValue={ef?.status ?? ""} className={`${inputCls} w-full`}>
                  <option value="">Any</option>
                  <option value="on_review">On review</option>
                  <option value="on_approval">On approval</option>
                  <option value="approved">Approved</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="rejected">Rejected</option>
                  <option value="on_hold">On hold</option>
                </select>
              </div>
              <div>
                <span className={labelCls}>Vendor contains</span>
                <input
                  name="f_vendor"
                  defaultValue={ef?.vendor ?? ""}
                  placeholder="e.g. Acme"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Project</span>
                <FilterCombobox
                  name="f_project"
                  formId={FORM_ID}
                  options={projectComboOptions}
                  defaultValue={ef?.project_id ?? ""}
                  placeholder="Search projects…"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Waiting for</span>
                <FilterCombobox
                  name="f_waiting_for"
                  formId={FORM_ID}
                  options={memberComboOptions}
                  defaultValue={ef?.waiting_for_user_id ?? ""}
                  placeholder="Search people…"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Approved by</span>
                <FilterCombobox
                  name="f_approved_by"
                  formId={FORM_ID}
                  options={memberComboOptions}
                  defaultValue={ef?.approved_by_user_id ?? ""}
                  placeholder="Search people…"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Requester</span>
                <FilterCombobox
                  name="f_requester"
                  formId={FORM_ID}
                  options={memberComboOptions}
                  defaultValue={ef?.submitted_by_user_id ?? ""}
                  placeholder="Search people…"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Amount over</span>
                <input
                  name="f_amount_over"
                  type="number"
                  step="0.01"
                  defaultValue={ef?.amount_over ?? ""}
                  placeholder="e.g. 500"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Amount under</span>
                <input
                  name="f_amount_under"
                  type="number"
                  step="0.01"
                  defaultValue={ef?.amount_under ?? ""}
                  placeholder="e.g. 5000"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>From date</span>
                <input name="f_from" type="date" defaultValue={ef?.from ?? ""} className={`${inputCls} w-full`} />
              </div>
              <div>
                <span className={labelCls}>To date</span>
                <input name="f_to" type="date" defaultValue={ef?.to ?? ""} className={`${inputCls} w-full`} />
              </div>
            </div>

            <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Visible columns
            </div>
            <p className="mt-0.5 text-xs text-slate-400">Name always shows — it links to the invoice.</p>
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3 md:grid-cols-5">
              {REPORT_COLUMNS.map((col) => (
                <label key={col.id} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="columns"
                    value={col.id}
                    defaultChecked={editingColumns.includes(col.id)}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  {col.label}
                </label>
              ))}
            </div>

            <SubmitButton className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              {editingReport ? "Save changes" : "Save & run report"}
            </SubmitButton>
          </form>

          {/* Saved reports — card grid, each naming its own filters, e.g.
              "Status is On approval" (mirrors ApprovalMax's own "Request
              reports" screen). Click anywhere in the card (outside Edit/
              Delete) to run it — the whole box, not just the title text,
              is the Link's own padded box (padding moved onto the Link
              itself rather than the outer card) so there's no dead
              whitespace around the title that looks clickable but isn't. */}
          <div className="mt-6">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Saved reports
            </div>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(reports ?? []).map((r) => {
                const cfg = r.config as unknown as ReportConfig;
                const lines = describeReportConfig(cfg, projectNameById, memberNameById);
                const active = runningReport?.id === r.id;
                return (
                  <div
                    key={r.id}
                    className={`flex flex-col overflow-hidden rounded-lg border bg-white ${
                      active ? "border-blue-400 ring-1 ring-blue-100" : "border-slate-200"
                    }`}
                  >
                    <Link href={`/reports?run=${r.id}`} className="flex-1 p-4 hover:bg-slate-50">
                      <div className="text-sm font-semibold text-slate-800 hover:text-blue-600">
                        {r.name}
                      </div>
                      <ul className="mt-1.5 space-y-0.5 text-xs text-slate-500">
                        {lines.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </Link>
                    <div className="flex flex-none items-center gap-3 border-t border-slate-100 px-4 py-2">
                      <Link
                        href={`/reports?edit=${r.id}`}
                        className="text-xs font-medium leading-none text-slate-500 hover:text-slate-700 hover:underline"
                      >
                        Edit
                      </Link>
                      <ConfirmSubmitButton
                        action={deleteReport.bind(null, r.id)}
                        confirmMessage={`Delete the report "${r.name}"? This can't be undone.`}
                        className="text-xs font-medium leading-none text-red-500 hover:underline"
                      >
                        Delete
                      </ConfirmSubmitButton>
                    </div>
                  </div>
                );
              })}
              {(reports ?? []).length === 0 && (
                <p className="text-sm text-slate-400">
                  No saved reports yet — build one above.
                </p>
              )}
            </div>
          </div>

          {/* Results */}
          {runningReport && result && (
            <div className="mt-6 rounded-lg border border-slate-200 bg-white shadow-elevation-1">
              <div className="border-b border-slate-200 px-4 py-3">
                <h2 className="text-base font-semibold">{runningReport.name}</h2>
                <p className="text-xs text-slate-400">
                  {result.rows.length} group
                  {result.rows.length === 1 ? "" : "s"} ·{" "}
                  {result.totals.count} invoices
                  {result.metric !== "count"
                    ? ` · ${
                        result.metric === "amount"
                          ? fmtNum(result.totals.amount)
                          : fmtNum(result.totals.tax)
                      } total`
                    : ""}
                </p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2 font-semibold">
                      {result.groupBy === "none"
                        ? "Result"
                        : result.groupBy}
                    </th>
                    <th className="px-4 py-2 text-right font-semibold">Count</th>
                    {result.metric !== "count" && (
                      <th className="px-4 py-2 text-right font-semibold">
                        {result.metric === "amount" ? "Amount" : "Tax"}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.key} className="border-b border-slate-50">
                      <td className="px-4 py-2 text-slate-700">{row.key}</td>
                      <td className="px-4 py-2 text-right text-slate-700">
                        {row.count}
                      </td>
                      {result.metric !== "count" && (
                        <td className="px-4 py-2 text-right text-slate-700">
                          {fmtNum(
                            result.metric === "amount" ? row.amount : row.tax
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold">
                    <td className="px-4 py-2">Total</td>
                    <td className="px-4 py-2 text-right">{result.totals.count}</td>
                    {result.metric !== "count" && (
                      <td className="px-4 py-2 text-right">
                        {fmtNum(
                          result.metric === "amount"
                            ? result.totals.amount
                            : result.totals.tax
                        )}
                      </td>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Invoice list — one row per matching invoice, sorted by
              customer then supplier, with downloads — the ApprovalMax-
              style "Request reports" list rather than the grouped summary
              above. Only the columns picked in the builder (or, for an
              older saved report, DEFAULT_REPORT_COLUMNS) render — CSV
              matches exactly via the cols= query param. */}
          {runningReport && listRows && (
            <div className="mt-6 rounded-lg border border-slate-200 bg-white shadow-elevation-1">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="text-base font-semibold">Invoice list</h2>
                  <p className="text-xs text-slate-400">
                    {listRows.length} invoice{listRows.length === 1 ? "" : "s"} ·
                    sorted by customer, then supplier
                  </p>
                </div>
                {listRows.length > 0 && (
                  <div className="flex flex-none flex-wrap gap-2">
                    <a
                      href={`/api/reports/export${exportQs(runningFilters)}`}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Download CSV
                    </a>
                    <a
                      href={`/api/invoices/batch-export${idsQs}`}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Download invoices (PDF)
                    </a>
                    <a
                      href={`/api/reports/audit-export${idsQs}`}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Download audit reports (PDF)
                    </a>
                  </div>
                )}
              </div>
              {listRows.length === 0 ? (
                <p className="px-4 py-6 text-sm text-slate-400">
                  No invoices match this report&apos;s filters.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400">
                        <th className="whitespace-nowrap px-4 py-2 font-semibold">Name</th>
                        {activeColumns.includes("amount") && (
                          <th className="whitespace-nowrap px-4 py-2 text-right font-semibold">Amount</th>
                        )}
                        {activeColumns.includes("supplier") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Supplier</th>
                        )}
                        {activeColumns.includes("status") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Status</th>
                        )}
                        {activeColumns.includes("approvedBy") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Approved by</th>
                        )}
                        {activeColumns.includes("waitingFor") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Waiting for</th>
                        )}
                        {activeColumns.includes("createdAt") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Created</th>
                        )}
                        {activeColumns.includes("customers") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Customers</th>
                        )}
                        {activeColumns.includes("age") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Age</th>
                        )}
                        {activeColumns.includes("queueTime") && (
                          <th className="whitespace-nowrap px-4 py-2 font-semibold">Time in queue</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {listRows.map((row) => (
                        <tr key={row.id} className="border-b border-slate-50">
                          <td className="max-w-xs px-4 py-2">
                            <Link
                              href={`/dashboard/${row.id}`}
                              className="font-medium text-blue-600 hover:underline"
                            >
                              {row.name}
                            </Link>
                          </td>
                          {activeColumns.includes("amount") && (
                            <td className="whitespace-nowrap px-4 py-2 text-right text-slate-700">
                              {row.amount != null ? fmtNum(row.amount) : "—"}
                            </td>
                          )}
                          {activeColumns.includes("supplier") && (
                            <td className="px-4 py-2 text-slate-700">{row.supplier}</td>
                          )}
                          {activeColumns.includes("status") && (
                            <td className="whitespace-nowrap px-4 py-2 text-slate-700">{row.status}</td>
                          )}
                          {activeColumns.includes("approvedBy") && (
                            <td className="px-4 py-2 text-slate-700">{row.approvedBy}</td>
                          )}
                          {activeColumns.includes("waitingFor") && (
                            <td className="px-4 py-2 text-slate-700">{row.waitingFor}</td>
                          )}
                          {activeColumns.includes("createdAt") && (
                            <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                              {new Date(row.createdAt).toLocaleDateString()}
                            </td>
                          )}
                          {activeColumns.includes("customers") && (
                            <td className="px-4 py-2 text-slate-700">{row.customers}</td>
                          )}
                          {activeColumns.includes("age") && (
                            <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                              {fmtAge(row.ageDays)}
                            </td>
                          )}
                          {activeColumns.includes("queueTime") && (
                            <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                              {row.queueDays != null ? fmtAge(row.queueDays) : "—"}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
    </main>
  );
}
