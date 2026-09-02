"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { sendHoldbackClaimEmail } from "@/lib/notify";
import {
  detectRetainageLines,
  resolveRetainageRate,
  termCopy,
  type RetainageTerm,
} from "@/lib/retainage";

// Server actions for holdback / retainage. Every write goes through the
// admin client because invoice_retainage is money state: members read it
// through RLS, nothing writes it from the browser.
// Authored by Araza.

async function requireAdmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard");
  if (org.role !== "admin") redirect("/holdback?error=not-admin");
  return { supabase, user, org };
}

// Mark a supplier as working under a contract. Nothing accrues for a
// supplier until this is on — see migration 0098 for why the default is
// off.
export async function setSupplierSubcontractor(formData: FormData) {
  const { org } = await requireAdmin();
  const supplierId = String(formData.get("supplier_id") ?? "");
  if (!supplierId) redirect("/holdback?error=bad-supplier");

  const admin = createAdminClient();
  await admin
    .from("suppliers")
    .update({ is_subcontractor: formData.get("is_subcontractor") === "on" })
    .eq("id", supplierId)
    .eq("organization_id", org.id); // never reach outside the caller's org

  revalidatePath("/holdback");
  redirect("/holdback#subcontractors");
}

// Org-level configuration: which word, what rate, which QBO account.
export async function saveRetainageSettings(formData: FormData) {
  const { org } = await requireAdmin();

  const term = String(formData.get("retainage_term") ?? "holdback");
  if (!["holdback", "retainage", "retention"].includes(term)) {
    redirect("/holdback?error=bad-term");
  }
  const rateRaw = String(formData.get("retainage_default_rate") ?? "").trim();
  const rate = rateRaw === "" ? null : Number(rateRaw);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
    redirect("/holdback?error=bad-rate");
  }

  const admin = createAdminClient();
  await admin
    .from("organizations")
    .update({
      retainage_term: term as RetainageTerm,
      retainage_default_rate: rate,
      retainage_account_qbo_id:
        String(formData.get("retainage_account_qbo_id") ?? "").trim() || null,
    })
    .eq("id", org.id);

  revalidatePath("/holdback");
  redirect("/holdback#settings");
}

// Per-project: the rate if it differs, and the date that starts the
// release clock.
export async function saveProjectRetainage(formData: FormData) {
  const { org } = await requireAdmin();
  const projectId = String(formData.get("project_id") ?? "");
  if (!projectId) redirect("/holdback?error=bad-project");

  const rateRaw = String(formData.get("retainage_rate") ?? "").trim();
  const rate = rateRaw === "" ? null : Number(rateRaw);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
    redirect("/holdback?error=bad-rate");
  }
  const spRaw = String(formData.get("substantial_performance_at") ?? "").trim();

  const admin = createAdminClient();
  await admin
    .from("projects")
    .update({
      retainage_rate: rate,
      substantial_performance_at: spRaw || null,
    })
    .eq("id", projectId)
    .eq("organization_id", org.id);

  revalidatePath("/holdback");
  redirect("/holdback#projects");
}

// Scan this org's invoices and write an accrual for every holdback line
// found on a subcontractor's bill.
//
// Idempotent by construction: accruals are keyed to the line item
// (migration 0099), so re-running updates the same rows rather than
// doubling the balance. That matters — this is the button someone will
// press twice.
//
// Only ever touches rows still in 'accrued'. Once a holdback has been
// claimed or released, its row is history and a re-scan must not rewrite
// it.
export async function rescanRetainage(): Promise<void> {
  const { supabase, org } = await requireAdmin();

  const { data: orgRow } = await supabase
    .from("organizations")
    .select("retainage_default_rate")
    .eq("id", org.id)
    .single();

  const { data: subcontractors } = await supabase
    .from("suppliers")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_subcontractor", true);
  const subIds = (subcontractors ?? []).map((s) => s.id);
  if (subIds.length === 0) {
    revalidatePath("/holdback");
    redirect("/holdback?scanned=0");
  }

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, supplier_id, project_id")
    .eq("organization_id", org.id)
    .in("supplier_id", subIds);

  const { data: projects } = await supabase
    .from("projects")
    .select("id, retainage_rate")
    .eq("organization_id", org.id);
  const rateByProject = new Map(
    (projects ?? []).map((p) => [p.id, p.retainage_rate])
  );

  const admin = createAdminClient();
  let written = 0;

  for (const inv of invoices ?? []) {
    const { data: lines } = await supabase
      .from("invoice_line_items")
      .select("id, description, amount, project_id")
      .eq("invoice_id", inv.id)
      .order("line_order");
    if (!lines?.length) continue;

    const expected = resolveRetainageRate(
      orgRow,
      { retainage_rate: rateByProject.get(inv.project_id ?? "") ?? null },
      { is_subcontractor: true } // already filtered to subcontractors above
    );

    for (const hit of detectRetainageLines(lines, expected)) {
      const { error } = await admin.from("invoice_retainage").upsert(
        {
          organization_id: org.id,
          invoice_id: inv.id,
          line_item_id: hit.lineItemId,
          // The line's own project wins: two lines on one bill can be
          // two different jobs, which is the whole reason accruals are
          // per line.
          project_id: hit.projectId ?? inv.project_id ?? null,
          supplier_id: inv.supplier_id,
          amount: hit.amount,
          rate: hit.rate,
          source: "billed",
        },
        { onConflict: "line_item_id" }
      );
      if (!error) written += 1;
    }
  }

  revalidatePath("/holdback");
  redirect(`/holdback?scanned=${written}`);
}

// Email every subcontractor still holding an accrual on a project,
// asking them to invoice for it.
//
// This is the only action here that reaches outside the organization —
// it emails a customer's subcontractors over their name — so it is
// admin-only, explicit per project, and records exactly what was sent.
// A send that fails leaves the row untouched rather than marking it
// requested, because a row wrongly marked as chased is one nobody ever
// chases again.
export async function requestHoldbackClaims(projectId: string): Promise<void> {
  const { supabase, org } = await requireAdmin();
  if (!projectId) redirect("/holdback?error=bad-project");

  const [{ data: orgRow }, { data: project }, { data: rows }] = await Promise.all([
    supabase
      .from("organizations")
      .select("name, retainage_term, statement_reply_to")
      .eq("id", org.id)
      .single(),
    supabase.from("projects").select("name").eq("id", projectId).single(),
    supabase
      .from("invoice_retainage")
      .select("id, amount, supplier_id, invoice_id")
      .eq("organization_id", org.id)
      .eq("project_id", projectId)
      .eq("status", "accrued"),
  ]);
  if (!rows?.length) redirect("/holdback?error=nothing-to-claim");

  const supplierIds = [...new Set(rows.map((r) => r.supplier_id).filter(Boolean))] as string[];
  const invoiceIds = [...new Set(rows.map((r) => r.invoice_id))];

  const [{ data: suppliers }, { data: invoices }] = await Promise.all([
    supabase.from("suppliers").select("id, name, qbo_vendor_id").in("id", supplierIds),
    supabase.from("invoices").select("id, invoice_number, currency, created_at").in("id", invoiceIds),
  ]);

  // Addresses live on the QBO vendor mirror, populated by the supplier
  // sync (migration 0097 added the column).
  const vendorIds = (suppliers ?? []).map((s) => s.qbo_vendor_id).filter(Boolean) as string[];
  const { data: qboVendors } = vendorIds.length
    ? await supabase
        .from("qbo_suppliers")
        .select("qbo_vendor_id, email")
        .eq("organization_id", org.id)
        .in("qbo_vendor_id", vendorIds)
    : { data: [] };
  const emailByVendorId = new Map(
    (qboVendors ?? []).map((v) => [v.qbo_vendor_id, v.email])
  );
  const invoiceById = new Map((invoices ?? []).map((i) => [i.id, i]));
  const supplierById = new Map((suppliers ?? []).map((s) => [s.id, s]));

  const admin = createAdminClient();
  const term = termCopy(orgRow?.retainage_term as RetainageTerm);
  let sent = 0;
  let skipped = 0;

  for (const supplierId of supplierIds) {
    const supplier = supplierById.get(supplierId);
    const email = supplier?.qbo_vendor_id
      ? emailByVendorId.get(supplier.qbo_vendor_id)
      : null;
    const mine = rows.filter((r) => r.supplier_id === supplierId);
    if (!supplier || !email || mine.length === 0) {
      skipped += 1; // no address on file — surfaced on the page, not silently dropped
      continue;
    }

    const total = mine.reduce((s, r) => s + Number(r.amount), 0);
    const result = await sendHoldbackClaimEmail({
      to: email,
      termNoun: term.noun,
      supplierName: supplier.name,
      organizationName: orgRow?.name ?? "Accounts Payable",
      projectName: project?.name ?? null,
      totalAmount: total,
      currency: invoiceById.get(mine[0].invoice_id)?.currency ?? "CAD",
      lines: mine.map((r) => {
        const inv = invoiceById.get(r.invoice_id);
        return {
          invoiceNumber: inv?.invoice_number ?? null,
          date: inv?.created_at ? new Date(inv.created_at).toLocaleDateString() : null,
          amount: Number(r.amount),
        };
      }),
      replyTo: orgRow?.statement_reply_to ?? null,
    });

    if (!result.ok) {
      skipped += 1;
      continue;
    }
    await admin
      .from("invoice_retainage")
      .update({ status: "claim_requested", claim_requested_at: new Date().toISOString() })
      .in("id", mine.map((r) => r.id));
    sent += 1;
  }

  revalidatePath("/holdback");
  redirect(`/holdback?claims_sent=${sent}&claims_skipped=${skipped}#projects`);
}

// Mark a project's retainage released. Closes out every row still open
// on that job and stamps the project, which is what stops it appearing
// as outstanding.
export async function releaseProjectRetainage(projectId: string): Promise<void> {
  const { org } = await requireAdmin();
  if (!projectId) redirect("/holdback?error=bad-project");

  const now = new Date().toISOString();
  const admin = createAdminClient();

  await admin
    .from("invoice_retainage")
    .update({ status: "released", released_at: now })
    .eq("organization_id", org.id)
    .eq("project_id", projectId)
    .in("status", ["accrued", "claim_requested"]);

  await admin
    .from("projects")
    .update({ retainage_released_at: now })
    .eq("id", projectId)
    .eq("organization_id", org.id);

  revalidatePath("/holdback");
  redirect("/holdback?released=1#projects");
}
