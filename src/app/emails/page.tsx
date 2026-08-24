import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { clsx } from "clsx";

// Email queue — every email received at the org's capture address
// (invoices@…), with what happened to it: processed into an invoice,
// routed to split review, unmatched, or failed. The inbox the database
// always had, made visible.
export default async function EmailsPage({
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

  const filter = ["all", "pending", "processed", "failed"].includes(
    searchParams.f ?? ""
  )
    ? (searchParams.f as string)
    : "pending";

  let query = supabase
    .from("inbound_email_log")
    .select("*")
    .eq("organization_id", org.id);
  if (filter === "pending") query = query.eq("processed", false);
  if (filter === "processed") query = query.eq("processed", true);
  if (filter === "failed")
    query = query.eq("processed", false).not("error", "is", null);

  const [{ data: emails }, counts] = await Promise.all([
    query.order("created_at", { ascending: false }).limit(100),
    (async () => {
      const count = async (f: string) => {
        let q = supabase
          .from("inbound_email_log")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org.id);
        if (f === "pending") q = q.eq("processed", false);
        if (f === "processed") q = q.eq("processed", true);
        if (f === "failed")
          q = q.eq("processed", false).not("error", "is", null);
        const { count } = await q;
        return count ?? 0;
      };
      return {
        all: await count("all"),
        pending: await count("pending"),
        processed: await count("processed"),
        failed: await count("failed"),
      };
    })(),
  ]);

  // Invoice names for the "Processed" links.
  const invoiceIds = [
    ...new Set((emails ?? []).flatMap((e) => e.invoice_ids ?? [])),
  ];
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

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link
        href="/dashboard"
        className="text-sm text-slate-500 hover:underline"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Email queue</h1>
      <p className="mt-1 text-sm text-slate-500">
        Every email received at{" "}
        <span className="font-mono text-slate-700">
          {org.inbound_email_local ?? org.inbound_email_token}@
          {process.env.INBOUND_EMAIL_DOMAIN ?? "…"}
        </span>{" "}
        — and what happened to it.
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/emails${t.key === "pending" ? "" : `?f=${t.key}`}`}
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
      </div>

      {!emails || emails.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">
          {filter === "pending"
            ? "No pending emails. Emails that arrive but don't become an invoice will show up here."
            : "Nothing here yet."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {emails.map((e) => {
            const status = statusOf(e);
            return (
              <li key={e.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs text-slate-400">
                    {fmtTime(e.created_at)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                    {e.subject || "(no subject)"}
                  </span>
                  <StatusChip status={status} />
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span className="truncate" title={e.from_address ?? ""}>
                    From: {e.from_address ?? "—"}
                  </span>
                  <span className="truncate" title={e.to_address ?? ""}>
                    To: {e.to_address ?? "—"}
                  </span>
                  <span>
                    {e.attachment_count} attachment
                    {e.attachment_count === 1 ? "" : "s"}
                  </span>
                </div>
                {status === "processed" &&
                  (e.invoice_ids ?? []).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {(e.invoice_ids ?? []).map((id) => {
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
                {status === "split" && (
                  <div className="mt-1.5">
                    <Link
                      href="/invoices/pending-splits"
                      className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                    >
                      Review split →
                    </Link>
                  </div>
                )}
                {status === "failed" && e.error && (
                  <p
                    className="mt-1.5 text-xs text-rose-600"
                    title={e.error}
                  >
                    {e.error}
                  </p>
                )}
                {status === "unmatched" && (
                  <p className="mt-1.5 text-xs text-slate-500">
                    No company matched the address it was sent to.
                  </p>
                )}
                {status === "received" && (
                  <p className="mt-1.5 text-xs text-slate-500">
                    Received, but no invoice was created from it (no PDF or
                    image attachments).
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

function statusOf(e: {
  processed: boolean;
  invoice_ids: string[];
  pending_split_ids: string[];
  error: string | null;
}): "processed" | "split" | "unmatched" | "failed" | "received" {
  if (e.processed && (e.invoice_ids ?? []).length > 0) return "processed";
  if (e.processed && (e.pending_split_ids ?? []).length > 0) return "split";
  if (!e.processed && e.error?.includes("No organization found"))
    return "unmatched";
  if (!e.processed && e.error) return "failed";
  return "received";
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    processed: { label: "Processed", cls: "bg-emerald-50 text-emerald-700" },
    split: { label: "Split review", cls: "bg-amber-50 text-amber-700" },
    unmatched: { label: "Unmatched", cls: "bg-slate-100 text-slate-500" },
    failed: { label: "Failed", cls: "bg-rose-50 text-rose-700" },
    received: { label: "No invoice", cls: "bg-slate-100 text-slate-500" },
  };
  const m = map[status] ?? map.received;
  return (
    <span
      className={clsx(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        m.cls
      )}
    >
      {m.label}
    </span>
  );
}
