import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { BackToDashboardButton } from "@/components/BackToDashboardButton";
import { NotificationRow } from "@/components/NotificationRow";

export default async function NotificationsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");

  const { data: notifications } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const invoiceIds = [
    ...new Set((notifications ?? []).map((n) => n.invoice_id).filter((id): id is string => !!id)),
  ];
  const actorIds = [
    ...new Set((notifications ?? []).map((n) => n.actor_id).filter((id): id is string => !!id)),
  ];
  const [{ data: invoices }, { data: actors }] = await Promise.all([
    invoiceIds.length > 0
      ? supabase.from("invoices").select("id, vendor_name, invoice_number, file_name").in("id", invoiceIds)
      : Promise.resolve({ data: [] }),
    actorIds.length > 0
      ? supabase.from("profiles").select("id, full_name").in("id", actorIds)
      : Promise.resolve({ data: [] }),
  ]);
  const invoiceById = new Map((invoices ?? []).map((i) => [i.id, i]));
  const actorNameById = new Map((actors ?? []).map((a) => [a.id, a.full_name ?? "Team member"]));

  const unread = (notifications ?? []).filter((n) => !n.read);
  const done = (notifications ?? []).filter((n) => n.read);

  const renderRow = (n: NonNullable<typeof notifications>[number]) => {
    const invoice = n.invoice_id ? invoiceById.get(n.invoice_id) : null;
    const label = invoice
      ? `${invoice.vendor_name ?? invoice.file_name}${
          invoice.invoice_number ? ` #${invoice.invoice_number}` : ""
        }`
      : "an invoice";
    const actorName = n.actor_id ? actorNameById.get(n.actor_id) ?? "Team member" : "Someone";
    return (
      <li key={n.id}>
        <NotificationRow
          href={n.invoice_id ? `/dashboard/${n.invoice_id}?n=${n.id}` : "/dashboard"}
          read={n.read}
        >
          <p className="min-w-0 flex-1 truncate text-sm text-slate-700">
            {n.type === "assigned" ? (
              <>
                <span className="font-medium">{label}</span> is ready for
                your approval
              </>
            ) : n.type === "rejected" ? (
              <>
                <span className="font-medium">{actorName}</span> rejected{" "}
                <span className="font-medium">{label}</span>
              </>
            ) : (
              <>
                <span className="font-medium">{actorName}</span>{" "}
                mentioned you on <span className="font-medium">{label}</span>
              </>
            )}
          </p>
          <span className="flex-none text-xs text-slate-400">
            {new Date(n.created_at).toLocaleString()}
          </span>
        </NotificationRow>
      </li>
    );
  };

  return (
    <main className="mx-auto max-w-2xl p-8">
      <BackToDashboardButton />
      <h1 className="mt-2 text-xl font-semibold">Mentions</h1>
      <p className="mt-1 text-sm text-slate-500">
        @mentions in Discussion, and invoices that just became yours to
        review — click one to open it. It&apos;s marked done once you do.
      </p>

      {(notifications ?? []).length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">No notifications yet.</p>
      ) : (
        <>
          {unread.length > 0 && (
            <div className="mt-6">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Unread ({unread.length})
              </h2>
              <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {unread.map(renderRow)}
              </ul>
            </div>
          )}
          {done.length > 0 && (
            <div className="mt-8">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Done ({done.length})
              </h2>
              <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                {done.map(renderRow)}
              </ul>
            </div>
          )}
        </>
      )}
    </main>
  );
}
