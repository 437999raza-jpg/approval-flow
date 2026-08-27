import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import {
  deleteInboundEmailLog,
  deleteUploadLogEntry,
  clearCompletedQueue,
  reprocessIngestJob,
} from "@/lib/dashboard-actions";
import { RemoveQueueEntryButton } from "@/components/RemoveQueueEntryButton";
import { ReprocessQueueButton } from "@/components/ReprocessQueueButton";
import { ExtractionPoller } from "@/components/ExtractionPoller";
import { LocalTime } from "@/components/LocalTime";
import { clsx } from "clsx";

// The queue — ONE place showing everything that has come into the app:
// manual uploads (upload_log) and inbound emails (inbound_email_log),
// merged newest-first with what happened to each. Filters let you see
// what's pending attention, what processed, and what failed.
type SkippedAttachment = { name: string; reason: string };
type QueueRow = {
  id: string;
  kind: "email" | "upload";
  createdAt: string;
  title: string;
  detail: string;
  status: "processing" | "processed" | "split" | "unmatched" | "no_invoice" | "failed" | "received";
  invoiceIds: string[];
  error: string | null;
  jobId: string | null;
  skipped?: SkippedAttachment[];
};

export default async function QueuePage({
  searchParams,
}: {
  searchParams: { f?: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");
  // The Queue (uploads + emails + outcomes) is an admin tool.
  if (org.role !== "admin") redirect("/dashboard");
  const isAdmin = true;

  const filter = ["all", "pending", "processed", "failed"].includes(
    searchParams.f ?? ""
  )
    ? (searchParams.f as string)
    : "all";

  const [{ data: emails }, { data: uploads }, { data: jobs }] =
    await Promise.all([
      supabase
        .from("inbound_email_log")
        .select("*")
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("upload_log")
        .select("*")
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("ingest_jobs")
        .select("id, upload_log_id, inbound_email_log_id, status")
        .eq("organization_id", org.id)
        .limit(200),
    ]);

  // Map display rows to their ingest job (for the Reprocess button).
  const jobByUploadLog = new Map(
    (jobs ?? [])
      .filter((j) => j.upload_log_id)
      .map((j) => [j.upload_log_id, j.id])
  );
  const jobByEmailLog = new Map(
    (jobs ?? [])
      .filter((j) => j.inbound_email_log_id)
      .map((j) => [j.inbound_email_log_id, j.id])
  );

  // Merge both sources into one newest-first list.
  const rows: QueueRow[] = [
    ...(emails ?? []).map((e) => ({
      id: e.id,
      kind: "email" as const,
      createdAt: e.created_at,
      title: e.subject || "(no subject)",
      detail: e.from_address
        ? `From: ${e.from_address}`
        : "Inbound email",
      status: emailStatus(e),
      invoiceIds: e.invoice_ids ?? [],
      error: e.error,
      jobId: jobByEmailLog.get(e.id) ?? null,
      skipped: e.skipped_attachments ?? undefined,
    })),
    ...(uploads ?? []).map((u) => ({
      id: u.id,
      kind: "upload" as const,
      createdAt: u.created_at,
      title: u.filename,
      detail: "Manual upload",
      status: uploadStatus(u),
      invoiceIds: u.invoice_id ? [u.invoice_id] : [],
      error: u.error,
      jobId: jobByUploadLog.get(u.id) ?? null,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const isPending = (r: QueueRow) =>
    r.status === "processing" ||
    r.status === "unmatched" ||
    r.status === "no_invoice" ||
    r.status === "failed" ||
    r.status === "received";
  const isProcessed = (r: QueueRow) =>
    r.status === "processed" || r.status === "split";

  const filtered = rows.filter((r) => {
    if (filter === "pending") return isPending(r);
    if (filter === "processed") return isProcessed(r);
    if (filter === "failed") return r.status === "failed" || r.status === "unmatched";
    return true;
  });

  const counts = {
    pending: rows.filter(isPending).length,
    processed: rows.filter(isProcessed).length,
    failed: rows.filter((r) => r.status === "failed" || r.status === "unmatched").length,
    all: rows.length,
  };

  // Invoice names for links.
  const invoiceIds = [...new Set(rows.flatMap((r) => r.invoiceIds))];
  const { data: invoices } =
    invoiceIds.length > 0
      ? await supabase
          .from("invoices")
          .select("id, vendor_name, invoice_number")
          .in("id", invoiceIds)
      : { data: [] };
  const invoiceById = new Map((invoices ?? []).map((i) => [i.id, i]));

  const tabs: { key: string; label: string; n: number }[] = [
    { key: "pending", label: "Pending", n: counts.pending },
    { key: "all", label: "All", n: counts.all },
    { key: "processed", label: "Processed", n: counts.processed },
    { key: "failed", label: "Failed", n: counts.failed },
  ];

  return (
    <main className="mx-auto max-w-4xl p-8">
      <ExtractionPoller />
      <Link
        href="/dashboard"
        className="text-sm text-slate-500 hover:underline"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Queue</h1>
      <p className="mt-1 text-sm text-slate-500">
        Everything that has come into the app — manual uploads and inbound
        emails — and what happened to it. Pending shows what still needs
        attention.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/queue${t.key === "all" ? "" : `?f=${t.key}`}`}
            className={clsx(
              "rounded-full px-3 py-1 text-xs font-medium",
              filter === t.key
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            )}
          >
            {t.label} ({t.n})
          </Link>
        ))}
        <span className="flex-1" />
        {isAdmin && (
          <form action={clearCompletedQueue}>
            <button
              type="submit"
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Clear completed
            </button>
          </form>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">
          {filter === "pending"
            ? "Nothing pending. Items that fail or arrive without a usable document will show up here."
            : "Nothing here yet."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {filtered.map((r) => (
            <li key={`${r.kind}-${r.id}`} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <LocalTime
                  iso={r.createdAt}
                  className="text-xs text-slate-400"
                />
                <span
                  className={clsx(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    r.kind === "email"
                      ? "bg-slate-100 text-slate-500"
                      : "bg-blue-50 text-blue-600"
                  )}
                >
                  {r.kind === "email" ? "Email" : "Upload"}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                  {r.title}
                </span>
                <StatusChip status={r.status} />
                {isAdmin && (
                  <RemoveQueueEntryButton
                    kind={r.kind}
                    id={r.id}
                    emailAction={deleteInboundEmailLog}
                    uploadAction={deleteUploadLogEntry}
                  />
                )}
                {isAdmin &&
                  r.jobId &&
                  (r.status === "no_invoice" || r.status === "failed") && (
                    <ReprocessQueueButton
                      jobId={r.jobId}
                      action={reprocessIngestJob}
                    />
                  )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span className="truncate" title={r.detail}>
                  {r.detail}
                </span>
              </div>
              {r.status === "processed" && r.invoiceIds.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {r.invoiceIds.map((id) => {
                    const inv = invoiceById.get(id);
                    return (
                      <Link
                        key={id}
                        href={`/dashboard/${id}`}
                        className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                      >
                        {inv
                          ? `${inv.vendor_name ?? "Invoice"} · #${inv.invoice_number ?? "—"} →`
                          : "Open invoice →"}
                      </Link>
                    );
                  })}
                </div>
              )}
              {r.status === "split" && (
                <div className="mt-1.5">
                  <Link
                    href="/invoices/pending-splits"
                    className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                  >
                    Review split →
                  </Link>
                </div>
              )}
              {r.status === "failed" && r.error && (
                <p className="mt-1.5 text-xs text-rose-600" title={r.error}>
                  {r.error}
                </p>
              )}
              {r.skipped && r.skipped.length > 0 && (
                <p className="mt-1.5 text-xs text-slate-500" title={r.skipped.map((s) => `${s.name} — ${s.reason}`).join("\n")}>
                  Skipped {r.skipped.length} attachment{r.skipped.length > 1 ? "s" : ""}:{" "}
                  {r.skipped.map((s) => s.name).join(", ")}
                </p>
              )}
              {r.status === "unmatched" && (
                <p className="mt-1.5 text-xs text-slate-500">
                  No company matched the address it was sent to.
                </p>
              )}
              {r.status === "received" && (
                <p className="mt-1.5 text-xs text-slate-500">
                  Received, but no invoice was created from it (no usable PDF
                  or invoice images — see skipped attachments above).
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function emailStatus(e: {
  processed: boolean;
  processing: boolean;
  invoice_ids: string[];
  pending_split_ids: string[];
  error: string | null;
}): QueueRow["status"] {
  if (e.processing) return "processing";
  if (e.processed && (e.invoice_ids ?? []).length > 0) return "processed";
  if (e.processed && (e.pending_split_ids ?? []).length > 0) return "split";
  if (!e.processed && e.error?.includes("No organization found"))
    return "unmatched";
  if (!e.processed && e.error?.includes("No invoice data"))
    return "no_invoice";
  if (!e.processed && e.error) return "failed";
  return "received";
}

function uploadStatus(u: {
  status: string;
}): QueueRow["status"] {
  if (u.status === "queued" || u.status === "processing") return "processing";
  if (u.status === "done") return "processed";
  if (u.status === "split") return "split";
  if (u.status === "no_invoice") return "no_invoice";
  return "failed";
}

function StatusChip({ status }: { status: QueueRow["status"] }) {
  const map: Record<QueueRow["status"], { label: string; cls: string }> = {
    processing: { label: "Processing", cls: "bg-blue-50 text-blue-600" },
    processed: { label: "Processed", cls: "bg-emerald-50 text-emerald-700" },
    split: { label: "Split review", cls: "bg-amber-50 text-amber-700" },
    unmatched: { label: "Unmatched", cls: "bg-slate-100 text-slate-500" },
    no_invoice: { label: "No invoice data", cls: "bg-slate-100 text-slate-500" },
    failed: { label: "Failed", cls: "bg-rose-50 text-rose-700" },
    received: { label: "No invoice", cls: "bg-slate-100 text-slate-500" },
  };
  const m = map[status] ?? map.received;
  return (
    <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", m.cls)}>
      {m.label}
    </span>
  );
}
