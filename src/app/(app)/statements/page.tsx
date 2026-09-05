import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { uploadAndReconcileStatement } from "@/lib/dashboard-actions";
import { getCachedQboSuppliers } from "@/lib/org-cache";
import { hasStatementReconciliation } from "@/lib/plans";
import { StatementUploadForm } from "@/components/StatementUploadForm";
import { LocalTime } from "@/components/LocalTime";

// Statement Reconciliation — Detailed-plan-only. Upload a vendor's
// statement, extract its lines, and match them against this org's own
// invoices for that vendor. See src/lib/dashboard-actions.ts
// (uploadAndReconcileStatement) for the actual reconciliation logic.
// Authored by Araza.

export default async function StatementsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");
  if (org.role === "user") redirect("/dashboard");

  const { data: orgRow } = await supabase
    .from("organizations")
    .select("plan, custom_plan, trial_ends_at")
    .eq("id", org.id)
    .single();
  const entitled = hasStatementReconciliation(orgRow);

  const header = (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-green-dark">
          {org.name}
        </p>
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-brand-ink">
          Statement reconciliation
        </h1>
      </div>
    </>
  );

  if (!entitled) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        {header}
        <div className="mt-6 rounded-lg border border-brand-line bg-brand-mist p-6 text-center">
          <p className="text-sm text-brand-ink">
            Statement Reconciliation is part of the <strong>Detailed plan</strong> ($299/mo) —
            upload a vendor&apos;s statement and Flow matches it against your invoices
            automatically, flagging anything the vendor billed that never made it into Flow.
          </p>
          <Link
            href="/billing"
            className="mt-3 inline-block rounded-md bg-brand-green px-4 py-2 text-sm font-display font-bold text-white hover:bg-brand-green-dark"
          >
            View plans
          </Link>
        </div>
      </main>
    );
  }

  const [suppliers, { data: statements }] = await Promise.all([
    getCachedQboSuppliers(org.id),
    supabase
      .from("vendor_statements")
      .select("id, supplier_name, file_name, status, created_at")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      {header}
      <p className="mt-1 text-sm text-brand-muted">
        Upload a vendor&apos;s statement — Flow reads its invoice numbers and checks each one
        against what&apos;s already in Flow for that vendor.
      </p>

      {org.role === "admin" && (
        <div className="mt-6">
          <StatementUploadForm suppliers={suppliers} action={uploadAndReconcileStatement} />
        </div>
      )}

      <section className="mt-8">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          Past statements
        </div>
        {(statements ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-brand-muted">No statements uploaded yet.</p>
        ) : (
          <div className="mt-2 divide-y divide-brand-line rounded-lg border border-brand-line bg-white">
            {(statements ?? []).map((s) => (
              <Link
                key={s.id}
                href={`/statements/${s.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-brand-mist"
              >
                {/* min-w-0 lets this side actually shrink (flex items
                    default to min-width:auto, refusing to) — a long
                    filename was pushing the whole row past the phone
                    viewport instead of truncating with an ellipsis. */}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-brand-ink">{s.supplier_name}</div>
                  <div className="truncate text-xs text-brand-muted">{s.file_name}</div>
                </div>
                <div className="flex flex-none items-center gap-3">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      s.status === "reconciled"
                        ? "bg-brand-mist text-brand-green-dark"
                        : s.status === "error"
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {s.status === "reconciled" ? "Reconciled" : s.status === "error" ? "Error" : "Processing"}
                  </span>
                  <LocalTime iso={s.created_at} dateOnly className="text-xs text-brand-muted" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
