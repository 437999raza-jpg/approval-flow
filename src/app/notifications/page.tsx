import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";

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

  const unreadIds = (notifications ?? []).filter((n) => !n.read).map((n) => n.id);
  if (unreadIds.length > 0) {
    await supabase.from("notifications").update({ read: true }).in("id", unreadIds);
  }

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

  return (
    <main className="mx-auto max-w-2xl p-8">
      <Link href="/dashboard" className="text-sm text-slate-500 hover:underline">
        ← Back to dashboard
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Notifications</h1>
      <p className="mt-1 text-sm text-slate-500">
        @mentions in Discussion, and invoices that just became yours to review.
      </p>

      {(notifications ?? []).length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">No notifications yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {(notifications ?? []).map((n) => {
            const invoice = n.invoice_id ? invoiceById.get(n.invoice_id) : null;
            const label = invoice
              ? `${invoice.vendor_name ?? invoice.file_name}${
                  invoice.invoice_number ? ` #${invoice.invoice_number}` : ""
                }`
              : "an invoice";
            const actorName = n.actor_id ? actorNameById.get(n.actor_id) ?? "Team member" : "Someone";
            return (
              <li key={n.id}>
                <Link
                  href={n.invoice_id ? `/dashboard/${n.invoice_id}` : "/dashboard"}
                  className={`flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50 ${
                    !n.read ? "bg-blue-50/60" : ""
                  }`}
                >
                  <p className="min-w-0 truncate text-sm text-slate-700">
                    {n.type === "assigned" ? (
                      <>
                        <span className="font-medium">{label}</span> is ready for
                        your approval
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
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
