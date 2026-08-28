import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { SignOutButton } from "@/components/SignOutButton";
import { SubmitButton } from "@/components/SubmitButton";
import { runReport, type ReportConfig } from "@/lib/reports";
import { buildInvoiceListReport } from "@/lib/invoice-list-report";

// ---------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------

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
    },
  };

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
// Page
// ---------------------------------------------------------------------

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: { run?: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-xl font-semibold">No organization yet</h1>
        <p className="mt-2 text-slate-600">
          Your account isn&apos;t attached to an organization yet.
        </p>
      </main>
    );
  }

  const [{ data: reports }, { data: projects }] = await Promise.all([
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
  ]);

  // Run the requested report (if any).
  const runningReport = searchParams.run
    ? (reports ?? []).find((r) => r.id === searchParams.run)
    : undefined;
  const result = runningReport
    ? await runReport(
        supabase,
        org.id,
        runningReport.config as unknown as ReportConfig
      )
    : null;
  const runningFilters = runningReport
    ? (runningReport.config as unknown as ReportConfig).filters
    : null;
  const listRows = runningFilters
    ? await buildInvoiceListReport(supabase, org.id, runningFilters)
    : null;
  const exportQs = (f: typeof runningFilters) => {
    if (!f) return "";
    const params = new URLSearchParams();
    if (f.status) params.set("f_status", f.status);
    if (f.vendor) params.set("f_vendor", f.vendor);
    if (f.project_id) params.set("f_project", f.project_id);
    if (f.amount_over != null) params.set("f_amount_over", String(f.amount_over));
    if (f.amount_under != null) params.set("f_amount_under", String(f.amount_under));
    if (f.from) params.set("f_from", f.from);
    if (f.to) params.set("f_to", f.to);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  };

  const fmtNum = (n: number) =>
    n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const inputCls =
    "rounded-md border border-slate-300 px-2.5 py-2 text-sm focus:border-blue-500 focus:outline-none";
  const labelCls = "block text-[10px] font-semibold uppercase tracking-wide text-slate-400";

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <div className="text-sm font-semibold">{org.name}</div>
          <div className="mt-0.5 truncate text-xs text-slate-400">Reports</div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          <Link
            href="/dashboard"
            className="block rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            ← Back to dashboard
          </Link>
          <Link
            href="/workflows"
            className="block rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            Workflows
          </Link>
          <Link
            href="/settings"
            className="block rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            Settings
          </Link>
        </nav>
        <div className="flex items-center justify-between border-t border-slate-200 p-4">
          <span className="truncate text-xs text-slate-500">{user.email}</span>
          <SignOutButton />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">Reports</h1>
              <p className="mt-1 text-sm text-slate-500">
                Build and save your own reports. Every report runs against
                what you can see (admins see everything; members see their
                workflow-covered projects).
              </p>
            </div>
            <a
              href="/api/reports/export"
              className="flex-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Download all invoices (CSV)
            </a>
          </div>

          {/* Builder */}
          <form
            action={saveReport.bind(null, org.id)}
            className="mt-4 rounded-lg border border-slate-200 bg-white p-4"
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-52 flex-1">
                <span className={labelCls}>Report name</span>
                <input
                  name="name"
                  required
                  placeholder="e.g. Approved invoices by vendor"
                  className={`${inputCls} w-full`}
                />
              </div>
              <div>
                <span className={labelCls}>Metric</span>
                <select name="metric" defaultValue="count" className={inputCls}>
                  <option value="count">Count</option>
                  <option value="amount">Total amount</option>
                  <option value="tax">Total tax</option>
                </select>
              </div>
              <div>
                <span className={labelCls}>Group by</span>
                <select name="group_by" defaultValue="none" className={inputCls}>
                  <option value="none">No grouping</option>
                  <option value="month">Month</option>
                  <option value="vendor">Vendor</option>
                  <option value="status">Status</option>
                  <option value="project">Project</option>
                </select>
              </div>
            </div>

            <div className="mt-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">
              Filters
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-4">
              <div>
                <span className={labelCls}>Status</span>
                <select name="f_status" defaultValue="" className={`${inputCls} w-full`}>
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
                <input name="f_vendor" placeholder="e.g. Acme" className={`${inputCls} w-full`} />
              </div>
              <div>
                <span className={labelCls}>Project</span>
                <select name="f_project" defaultValue="" className={`${inputCls} w-full`}>
                  <option value="">Any</option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className={labelCls}>Amount over</span>
                <input name="f_amount_over" type="number" step="0.01" placeholder="e.g. 500" className={`${inputCls} w-full`} />
              </div>
              <div>
                <span className={labelCls}>Amount under</span>
                <input name="f_amount_under" type="number" step="0.01" placeholder="e.g. 5000" className={`${inputCls} w-full`} />
              </div>
              <div>
                <span className={labelCls}>From date</span>
                <input name="f_from" type="date" className={`${inputCls} w-full`} />
              </div>
              <div>
                <span className={labelCls}>To date</span>
                <input name="f_to" type="date" className={`${inputCls} w-full`} />
              </div>
            </div>

            <SubmitButton className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Save & run report
            </SubmitButton>
          </form>

          {/* Saved reports */}
          <div className="mt-6 flex flex-wrap gap-2">
            {(reports ?? []).map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <Link
                  href={`/reports?run=${r.id}`}
                  className="text-sm font-medium text-blue-600 hover:underline"
                >
                  {r.name}
                </Link>
                <form action={deleteReport.bind(null, r.id)}>
                  <SubmitButton className="text-xs text-red-500 hover:underline">
                    Delete
                  </SubmitButton>
                </form>
              </div>
            ))}
            {(reports ?? []).length === 0 && (
              <p className="text-sm text-slate-400">
                No saved reports yet — build one above.
              </p>
            )}
          </div>

          {/* Results */}
          {runningReport && result && (
            <div className="mt-6 rounded-lg border border-slate-200 bg-white">
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
              customer then supplier, with a download button — the
              ApprovalMax-style "Request reports" list rather than the
              grouped summary above. */}
          {runningReport && listRows && (
            <div className="mt-6 rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="text-base font-semibold">Invoice list</h2>
                  <p className="text-xs text-slate-400">
                    {listRows.length} invoice{listRows.length === 1 ? "" : "s"} ·
                    sorted by customer, then supplier
                  </p>
                </div>
                <a
                  href={`/api/reports/export${exportQs(runningFilters)}`}
                  className="flex-none rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Download CSV
                </a>
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
                        <th className="whitespace-nowrap px-4 py-2 text-right font-semibold">Amount</th>
                        <th className="whitespace-nowrap px-4 py-2 font-semibold">Supplier</th>
                        <th className="whitespace-nowrap px-4 py-2 font-semibold">Status</th>
                        <th className="whitespace-nowrap px-4 py-2 font-semibold">Approved by</th>
                        <th className="whitespace-nowrap px-4 py-2 font-semibold">Waiting for</th>
                        <th className="whitespace-nowrap px-4 py-2 font-semibold">Created</th>
                        <th className="whitespace-nowrap px-4 py-2 font-semibold">Customers</th>
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
                          <td className="whitespace-nowrap px-4 py-2 text-right text-slate-700">
                            {row.amount != null ? fmtNum(row.amount) : "—"}
                          </td>
                          <td className="px-4 py-2 text-slate-700">{row.supplier}</td>
                          <td className="whitespace-nowrap px-4 py-2 text-slate-700">{row.status}</td>
                          <td className="px-4 py-2 text-slate-700">{row.approvedBy}</td>
                          <td className="px-4 py-2 text-slate-700">{row.waitingFor}</td>
                          <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                            {new Date(row.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-2 text-slate-700">{row.customers}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
