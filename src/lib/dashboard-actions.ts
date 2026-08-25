"use server";

import { redirect } from "next/navigation";
import { revalidatePath, revalidateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { sendMentionEmail } from "@/lib/notify";
import {
  extractInvoiceFields,
  mapExtractionToInvoice,
} from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";
import { computeLineItemTotals } from "@/lib/invoice-totals";
import { normalizeForMatching } from "@/lib/matching";
import { holdbackCategoryFor } from "@/lib/invoices";
import {
  effectiveApproversForStep,
  stepDecisionState,
} from "@/lib/workflow-conditions";
import type { Database, InvoiceStatus } from "@/lib/supabase/types";
import { getQboConnection, listCategories, listTaxRates, listTaxCodes, listClasses, listSuppliers, listProjects, matchSupplier, createBill, attachDocuments, loadCategoryAccountCache, resolveCategoryAccount, loadTaxCodeCache, resolveTaxCode, loadClassCache, resolveClass } from "@/lib/qbo";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";
import { buildQboAttachmentBundle } from "@/lib/qbo-attachments";
import { pdfPageCount, reorderPdfPages } from "@/lib/merge-documents";
import { qboTag, INVOICES_TAG } from "@/lib/org-cache";

// Server actions for the dashboard (moved out of the page component so
// the page stays render-only). Authored by Araza.

export async function requiredApproversFor(
  supabase: ReturnType<typeof createClient>,
  step: Database["public"]["Tables"]["approval_workflow_steps"]["Row"],
  invoice: {
    id: string;
    vendor_name: string | null;
    project_id: string | null;
    step_override_approver_id: string | null;
  }
): Promise<string[]> {
  if (invoice.step_override_approver_id) return [invoice.step_override_approver_id];

  const { data: approversRaw } = await supabase
    .from("approval_workflow_step_approvers")
    .select("*")
    .eq("step_id", step.id);
  const approverIds = (approversRaw ?? []).map((a) => a.id);
  const { data: conditionsRaw } =
    approverIds.length > 0
      ? await supabase
          .from("approval_workflow_step_conditions")
          .select("*")
          .in("step_approver_id", approverIds)
      : { data: [] };
  const { data: lineItems } = await supabase
    .from("invoice_line_items")
    .select("class, category, project_id")
    .eq("invoice_id", invoice.id);

  return effectiveApproversForStep(
    (approversRaw ?? []).map((a) => ({
      id: a.id,
      approver_user_id: a.approver_user_id,
      is_default: a.is_default,
    })),
    (conditionsRaw ?? []).map((c) => ({
      step_approver_id: c.step_approver_id,
      field: c.field,
      operator: c.operator,
      match_values: c.match_values,
    })),
    { vendor_name: invoice.vendor_name, project_id: invoice.project_id },
    lineItems ?? []
  );
}

// When the form carries an "instructions" field (the Approve button lives
// in the Instructions for accounting section), it is saved as the bill
// memo before the decision — so "type the note, press Approve" works in
// one motion.
export async function decide(
  invoiceId: string,
  decision: "approved" | "rejected",
  formData: FormData
) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The accounting-instructions thread is append-only: whatever the
  // approver typed is added as their own line, never overwriting anyone
  // else's (the whole thread becomes the QBO memo on sync).
  const instructions = String(formData.get("instructions") ?? "").trim();
  const tickingCos = formData.get("has_cos_or_extras") === "on";

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();
  if (!invoice || !invoice.workflow_id) {
    redirect(`/dashboard/${invoiceId}?error=not-your-step`);
  }

  // CO/Extras is decided by the approver (usually the PM), then LOCKED:
  // once it's been set by anyone upstream, no later approver can remove it.
  const hasCosOrExtras = invoice.has_cos_or_extras || tickingCos;

  // CO/Extras rule: when flagged, a note for accounting is REQUIRED before
  // approving (the Approve button is also disabled client-side; this is the
  // server-side enforcement so it can't be bypassed).
  if (hasCosOrExtras && !instructions) {
    redirect(
      `/dashboard/${invoiceId}?error=cos-requires-note`
    );
  }

  if (instructions) {
    await supabase.from("accounting_instructions").insert({
      invoice_id: invoiceId,
      author_id: user.id,
      body: instructions,
    });
  }

  if (invoice.status !== "on_approval") {
    redirect(`/dashboard/${invoiceId}?error=already-decided`);
  }

  const { data: steps } = await supabase
    .from("approval_workflow_steps")
    .select("*")
    .eq("workflow_id", invoice.workflow_id)
    .order("step_order", { ascending: true });
  const orderedSteps = steps ?? [];

  const currentStep = orderedSteps.find(
    (s) => s.step_order === invoice.current_step_order
  );
  if (!currentStep) {
    redirect(`/dashboard/${invoiceId}?error=not-your-step`);
  }

  // Who's actually required to decide this step for THIS invoice.
  const requiredApproverIds = await requiredApproversFor(supabase, currentStep, invoice);

  if (!requiredApproverIds.includes(user.id)) {
    redirect(`/dashboard/${invoiceId}?error=not-your-step`);
  }

  const { data: existingDecisions } = await supabase
    .from("invoice_approvals")
    .select("approver_id, decision")
    .eq("invoice_id", invoiceId)
    .eq("step_order", invoice.current_step_order);

  const alreadyDecided = (existingDecisions ?? []).some(
    (a) => a.approver_id === user.id
  );
  if (alreadyDecided) {
    // Self-heal: if this step is already fully resolved (e.g. an earlier
    // attempt recorded the vote but the status update never landed), advance
    // the invoice instead of leaving it stuck on "already decided".
    const state = stepDecisionState(
      currentStep.approval_mode,
      requiredApproverIds,
      existingDecisions ?? []
    );
    if (state === "approved") {
      const lastStep = orderedSteps[orderedSteps.length - 1]?.step_order ?? 1;
      const isFinalStep = invoice.current_step_order >= lastStep;
      if (hasCosOrExtras) {
        await supabase
          .from("invoice_line_items")
          .update({ class: "Extras" })
          .eq("invoice_id", invoiceId);
        await supabase
          .from("invoices")
          .update({ has_cos_or_extras: true })
          .eq("id", invoiceId);
      }
      await supabase
        .from("invoices")
        .update({
          status: isFinalStep ? "qbo_ready" : "on_approval",
          current_step_order: isFinalStep
            ? invoice.current_step_order
            : invoice.current_step_order + 1,
          step_override_approver_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", invoiceId);
      revalidateTag(INVOICES_TAG);
      revalidatePath("/dashboard", "layout");
      return;
    }
    redirect(`/dashboard/${invoiceId}?error=already-decided`);
  }

  const { error: insertError } = await supabase
    .from("invoice_approvals")
    .insert({
      invoice_id: invoiceId,
      step_order: invoice.current_step_order,
      approver_id: user.id,
      decision,
    });
  if (insertError) {
    redirect(`/dashboard/${invoiceId}?error=already-decided`);
  }

  // Where this step's decision stands now that this vote is in. "all"
  // mode steps might still be waiting on other required approvers — the
  // invoice stays put at the same step until stepDecisionState resolves
  // to approved/rejected. A single reject always resolves the step (and
  // the whole invoice) immediately, regardless of mode.
  const state = stepDecisionState(currentStep.approval_mode, requiredApproverIds, [
    ...(existingDecisions ?? []),
    { approver_id: user.id, decision },
  ]);

  if (state === "rejected") {
    await supabase
      .from("invoices")
      .update({
        status: "rejected",
        step_override_approver_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoiceId);
  } else if (state === "approved") {
    const lastStep = orderedSteps[orderedSteps.length - 1]?.step_order ?? 1;
    const isFinalStep = invoice.current_step_order >= lastStep;

    // CO/Extras rule: when the approver (usually the PM) flags the invoice
    // as having COs or Extras, every line item's class is set to "Extras"
    // (a real QBO class) so they're separated in QBO reports, and the flag
    // is persisted on the invoice — LOCKED from here on, no later approver
    // can remove it.
    if (hasCosOrExtras) {
      await supabase
        .from("invoice_line_items")
        .update({ class: "Extras" })
        .eq("invoice_id", invoiceId);
      await supabase
        .from("invoices")
        .update({ has_cos_or_extras: true })
        .eq("id", invoiceId);
    }

    await supabase
      .from("invoices")
      .update({
        // Completing the LAST step lands the bill in 'qbo_ready', the
        // admin-only final gate — it sits there until an admin presses
        // "Sync to QuickBooks". Earlier steps stay 'on_approval'.
        status: isFinalStep ? "qbo_ready" : "on_approval",
        current_step_order: isFinalStep
          ? invoice.current_step_order
          : invoice.current_step_order + 1,
        // The reassignment applied to the step just decided, not
        // whatever comes next.
        step_override_approver_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoiceId);
  }
  // else "pending" — an "all" mode step still waiting on other required
  // approvers; this vote is recorded but the invoice stays on the same
  // step until everyone required has weighed in.


  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: `invoice.${decision}`,
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Post a message to an invoice's discussion thread. Any org member who can
// see the invoice can participate (RLS on invoice_comments gates it).
// @mentions (picked from the composer's dropdown, not parsed from free
// text — see MentionComposer) get an in-app notification row and a
// best-effort email with a direct link to this invoice, so they don't
// have to have the app open to find out.
export async function addComment(invoiceId: string, formData: FormData) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  const requestedMentionIds = String(formData.get("mentioned_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, vendor_name, invoice_number, file_name")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;

  // Only notify people who are actually members of this org — the
  // mentioned_ids field is client-supplied, don't trust it blindly. Never
  // notify yourself for your own comment.
  let mentionedIds: string[] = [];
  if (requestedMentionIds.length > 0) {
    const { data: members } = await supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", invoice.organization_id)
      .in("user_id", requestedMentionIds);
    mentionedIds = (members ?? [])
      .map((m) => m.user_id)
      .filter((id) => id !== user.id);
  }

  const { data: comment } = await supabase
    .from("invoice_comments")
    .insert({
      invoice_id: invoiceId,
      author_id: user.id,
      body,
      mentioned_user_ids: mentionedIds,
    })
    .select("id")
    .single();

  if (comment && mentionedIds.length > 0) {
    await supabase.from("notifications").insert(
      mentionedIds.map((uid) => ({
        organization_id: invoice.organization_id,
        user_id: uid,
        actor_id: user.id,
        invoice_id: invoiceId,
        comment_id: comment.id,
        type: "mention" as const,
      }))
    );

    const [{ data: actorProfile }, { data: authUsers }] = await Promise.all([
      supabase.from("profiles").select("full_name").eq("id", user.id).single(),
      createAdminClient().auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    const actorName = actorProfile?.full_name ?? "A teammate";
    const invoiceLabel = `${invoice.vendor_name ?? invoice.file_name}${
      invoice.invoice_number ? ` #${invoice.invoice_number}` : ""
    }`;
    const invoiceUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3210"}/dashboard/${invoiceId}`;
    const emailById = new Map(
      (authUsers?.users ?? []).map((u) => [u.id, u.email ?? null])
    );

    await Promise.all(
      mentionedIds.map((uid) => {
        const email = emailById.get(uid);
        return email
          ? sendMentionEmail({ to: email, actorName, invoiceLabel, commentBody: body, invoiceUrl })
          : Promise.resolve();
      })
    );
  }

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Add an extra document page to an invoice (multi-document support,
// migration 0003). All documents are attached to the QBO bill on sync.
export async function addDocument(invoiceId: string, formData: FormData) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > 20 * 1024 * 1024) return; // 20MB, same as ingestion
  const allowed = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) return;

  const { data: invoice } = await supabase
    .from("invoices")
    .select("organization_id")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const filePath = `${invoice.organization_id}/${invoiceId}-${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("invoices")
    .upload(filePath, file, { contentType: file.type, upsert: false });
  if (uploadError) return;

  await supabase.from("invoice_documents").insert({
    invoice_id: invoiceId,
    file_path: filePath,
    file_name: file.name,
    uploaded_by: user.id,
  });

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.document_added",
    metadata: { file_name: file.name },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Save the accounting instructions for an invoice (migration 0004). On QBO
// sync this becomes the bill's memo (PrivateNote) — internal guidance for
// the accounting team, not printed on the invoice.
export async function saveAccountingInstructions(
  invoiceId: string,
  formData: FormData
) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Append-only: adds a new instruction line for the signed-in user.
  const instructions = String(formData.get("instructions") ?? "").trim();
  if (!instructions) return;

  const { data: before } = await supabase
    .from("invoices")
    .select("organization_id")
    .eq("id", invoiceId)
    .single();
  if (!before) return;

  await supabase.from("accounting_instructions").insert({
    invoice_id: invoiceId,
    author_id: user.id,
    body: instructions,
  });

  await supabase.from("audit_log").insert({
    organization_id: before.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.accounting_instruction_added",
    metadata: { instructions },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Parse the Bill panel form into an invoices update object.
// amount/tax_amount are intentionally not parsed here — they're owned by
// the line items (see recomputeInvoiceTotals) and derived, not typed in.
function parseBillForm(formData: FormData): Record<string, unknown> {
  const text = (key: string) =>
    String(formData.get(key) ?? "").trim() || null;
  const date = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  };

  return {
    vendor_name: text("vendor_name"),
    source_email: text("source_email"),
    invoice_number: text("bill_number"),
    bill_date: date("bill_date"),
    due_date: date("due_date"),
    currency: text("currency")?.toUpperCase() || "USD",
  };
}

// Recompute and persist the invoice's amount/tax_amount from its current
// line items — the single source of truth after any add/edit/delete, so
// everything downstream (the Bill panel header, invoice list, reports,
// duplicate-amount comparison, workflow routing) stays in sync.
export async function recomputeInvoiceTotals(
  supabase: ReturnType<typeof createClient>,
  invoiceId: string
) {
  const { data: items } = await supabase
    .from("invoice_line_items")
    .select("amount, tax_rate")
    .eq("invoice_id", invoiceId);
  const { total, tax } = computeLineItemTotals(items ?? []);

  // Re-run the "document total wins" reconciliation: the printed total
  // (document_total) is ground truth. If the line items now match it, the
  // amber note CLEARS; if they still disagree, the document total stays and
  // the note stays. Fixing the lines to match the total makes the warning
  // disappear — that was the bug (the note was never recomputed on edits).
  const { data: invoice } = await supabase
    .from("invoices")
    .select("document_total")
    .eq("id", invoiceId)
    .single();
  const printedTotal = invoice?.document_total ?? null;
  let amount = total;
  let totalsNote: string | null = null;
  if (printedTotal != null && Math.abs(printedTotal - total) > 0.01) {
    amount = printedTotal;
    totalsNote = `Document total ${printedTotal.toFixed(2)} differs from line items (${total.toFixed(2)}). The document total was used.`;
  }

  await supabase
    .from("invoices")
    .update({
      amount,
      tax_amount: tax,
      totals_note: totalsNote,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);
}

const BILL_FIELD_LABELS: Record<string, string> = {
  vendor_name: "Vendor name",
  source_email: "Email",
  invoice_number: "Bill number",
  bill_date: "Bill date",
  due_date: "Due date",
  currency: "Currency",
};

// Persist the editable bill fields (also fired by Enter in the form).
// Diffs against the current row first so the audit log only records
// fields that actually changed, not every autosave-on-blur no-op.
export async function saveBill(invoiceId: string, formData: FormData) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: before } = await supabase
    .from("invoices")
    .select("organization_id, vendor_name, source_email, invoice_number, bill_date, due_date, currency")
    .eq("id", invoiceId)
    .single();
  if (!before) return;

  const next = parseBillForm(formData) as Record<string, string | null>;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(BILL_FIELD_LABELS)) {
    const from = (before as Record<string, unknown>)[key] ?? null;
    const to = next[key] ?? null;
    if (from !== to) changes[key] = { from, to };
  }

  // If the vendor changed, re-check it against the QBO mirror and update
  // the matched flag: an exact (normalized) match clears the warning; a
  // still-unmatched name keeps it flagged so the bill can't sync wrongly.
  const vendorChanged = next.vendor_name !== (before.vendor_name ?? null);
  let qboVendorMatched: boolean | undefined;
  if (vendorChanged && next.vendor_name) {
    const suppliers = await fetchAllQboSuppliers(supabase, before.organization_id);
    qboVendorMatched = matchSupplier(suppliers, next.vendor_name) !== null;
  } else if (vendorChanged && !next.vendor_name) {
    qboVendorMatched = false;
  }

  await supabase
    .from("invoices")
    .update({
      ...next,
      ...(qboVendorMatched !== undefined ? { qbo_vendor_matched: qboVendorMatched } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  if (Object.keys(changes).length > 0) {
    await supabase.from("audit_log").insert({
      organization_id: before.organization_id,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "invoice.bill_fields_edited",
      metadata: { changes },
    });
  }

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Dext/ApprovalMax-style supplier rules: save (upsert, keyed by normalized
// vendor name) and, if requested, retroactively apply Category/Class/
// Project/Tax rate to every line item — and Currency/due date (from
// Payment terms) to the invoice itself — of every other invoice from this
// same supplier still sitting in the review queue. Future invoices from
// this vendor pick up the rule automatically at ingestion (invoices.ts).
// invoiceId is null when saved from the Settings -> Suppliers page (not
// tied to any one bill) rather than the Bill panel's "Supplier rules"
// modal — both write the exact same supplier_defaults row through this
// one action, so the two places can never drift out of sync.
export async function saveSupplierDefaults(
  invoiceId: string | null,
  vendorName: string,
  formData: FormData
) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) return;

  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;
  const num = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const int = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  const values = {
    category: text("category"),
    class: text("class"),
    product_service: text("product_service"),
    project_id: text("project_id"),
    tax_rate: num("tax_rate"),
    payment_terms_days: int("payment_terms_days"),
    currency: text("currency")?.toUpperCase() ?? null,
  };

  // Only fields the user explicitly set become the rule — blanks never
  // overwrite existing defaults. Project stays a per-bill choice (a
  // supplier can work on many jobs), never saved as a supplier rule.
  const rule: Database["public"]["Tables"]["supplier_defaults"]["Update"] = {
    vendor_name: vendorName,
    updated_at: new Date().toISOString(),
  };
  if (values.category) rule.category = values.category;
  if (values.class) rule.class = values.class;
  if (values.product_service) rule.product_service = values.product_service;
  if (values.tax_rate != null) rule.tax_rate = values.tax_rate;
  if (values.payment_terms_days != null)
    rule.payment_terms_days = values.payment_terms_days;
  if (values.currency) rule.currency = values.currency;

  await supabase.from("supplier_defaults").upsert(
    {
      organization_id: org.id,
      vendor_name: vendorName,
      ...rule,
    },
    { onConflict: "organization_id,vendor_name_normalized" }
  );

  if (formData.get("apply_to_inbox") === "on") {
    const normalized = normalizeForMatching(vendorName);
    const { data: candidates } = await supabase
      .from("invoices")
      .select("id, bill_date, vendor_name")
      .eq("organization_id", org.id)
      .eq("status", "on_review");

    const matches = (candidates ?? []).filter(
      (i) => normalizeForMatching(i.vendor_name) === normalized
    );

    for (const inv of matches) {
      const invoiceUpdate: Database["public"]["Tables"]["invoices"]["Update"] = {};
      if (values.currency) invoiceUpdate.currency = values.currency;
      if (values.payment_terms_days != null && inv.bill_date) {
        const d = new Date(`${inv.bill_date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + values.payment_terms_days);
        invoiceUpdate.due_date = d.toISOString().slice(0, 10);
      }
      if (Object.keys(invoiceUpdate).length > 0) {
        await supabase.from("invoices").update(invoiceUpdate).eq("id", inv.id);
      }

      const lineItemUpdate: Database["public"]["Tables"]["invoice_line_items"]["Update"] =
        {};
      if (values.category) lineItemUpdate.category = values.category;
      if (values.class) lineItemUpdate.class = values.class;
      if (values.tax_rate != null) lineItemUpdate.tax_rate = values.tax_rate;
      if (Object.keys(lineItemUpdate).length > 0) {
        await supabase
          .from("invoice_line_items")
          .update(lineItemUpdate)
          .eq("invoice_id", inv.id);
      }
    }
  }

  await supabase.from("audit_log").insert({
    organization_id: org.id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "supplier_defaults.saved",
    metadata: { vendor_name: vendorName },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
  revalidatePath("/settings/suppliers");
}

// Which accounting platform a supplier belongs to — lives on qbo_suppliers
// (not supplier_defaults) since it's a property of the supplier record
// itself, not a default applied to its invoices. Purely informational
// today: every supplier comes from this org's one QBO connection, and
// nothing reads this field yet — it's there for whenever a Xero/Zoho
// Books connection exists to actually pick between.
export async function saveSupplierIntegration(
  qboSupplierId: string,
  formData: FormData
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) return;

  const integration = String(formData.get("integration") ?? "").trim();
  if (!integration) return;

  await supabase
    .from("qbo_suppliers")
    .update({ integration })
    .eq("id", qboSupplierId)
    .eq("organization_id", org.id);

  revalidatePath("/settings/suppliers");
}

// Is the signed-in user allowed to review extracted data (admin only)?
// Used by the review actions and to gate the Bill panel buttons.
export async function canReview(supabase: ReturnType<typeof createClient>) {
  const org = await getCurrentOrg(supabase);
  return org ? org.role === "admin" : false;
}

// Review Complete: moves an invoice out of the Pending Review queue into
// the approval workflow (status -> pending, workflow re-picked by the rules
// engine now that project/line items may be known). Bill fields save
// themselves on blur, so this action only needs to route.
export async function reviewComplete(invoiceId: string) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  const { data: inv } = await supabase
    .from("invoices")
    .select(
      "id, organization_id, status, amount, vendor_name, submitted_by, project_id"
    )
    .eq("id", invoiceId)
    .single();
  if (!inv || inv.status !== "on_review") return;

  const [{ data: profile }, { data: lineItems }] = await Promise.all([
    inv.submitted_by
      ? supabase
          .from("profiles")
          .select("full_name")
          .eq("id", inv.submitted_by)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("invoice_line_items")
      .select("category, description, class, amount, project_id")
      .eq("invoice_id", invoiceId),
  ]);

  // A bill can split across multiple projects (one per line item); the
  // invoice-level project_id (older data / simple single-project bills)
  // still counts too. "Customer" routing rules match on ANY of them.
  const projectIds = [
    ...new Set(
      [inv.project_id, ...(lineItems ?? []).map((l) => l.project_id)].filter(
        (id): id is string => !!id
      )
    ),
  ];
  const { data: projectRows } =
    projectIds.length > 0
      ? await supabase.from("projects").select("id, name").in("id", projectIds)
      : { data: [] };
  const projects = (projectRows ?? []).map((p) => ({ id: p.id, name: p.name }));

  const workflowId = await selectWorkflowForInvoice(
    supabase,
    inv.organization_id,
    {
      amount: inv.amount,
      vendorName: inv.vendor_name,
      submittedBy: inv.submitted_by,
      submitterName: profile?.full_name ?? null,
      projects,
      lineItems: lineItems ?? [],
    }
  );

  await supabase
    .from("invoices")
    .update({
      workflow_id: workflowId,
      status: "on_approval",
      current_step_order: 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: inv.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.review_done",
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Hold: the current-step approver puts an in-flight invoice on hold (a
// decision later — approve, reject, or return to review).
export async function holdInvoice(invoiceId: string) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select(
      "id, organization_id, status, workflow_id, current_step_order, step_override_approver_id, vendor_name, project_id"
    )
    .eq("id", invoiceId)
    .single();
  if (!invoice || !invoice.workflow_id) return;
  if (invoice.status !== "on_approval") return;

  const { data: currentStep } = await supabase
    .from("approval_workflow_steps")
    .select("*")
    .eq("workflow_id", invoice.workflow_id)
    .eq("step_order", invoice.current_step_order)
    .maybeSingle();
  if (!currentStep) return;
  const requiredApproverIds = await requiredApproversFor(supabase, currentStep, invoice);
  if (!requiredApproverIds.includes(user.id)) return;

  await supabase
    .from("invoices")
    .update({ status: "on_hold", updated_at: new Date().toISOString() })
    .eq("id", invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.held",
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Unhold: the approver who put an invoice on hold resumes it — back to
// on_approval at the same step, with all decision buttons restored.
export async function unholdInvoice(invoiceId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select(
      "id, organization_id, status, workflow_id, current_step_order, step_override_approver_id, vendor_name, project_id"
    )
    .eq("id", invoiceId)
    .single();
  if (!invoice || !invoice.workflow_id) return;
  if (invoice.status !== "on_hold") return;

  const { data: currentStep } = await supabase
    .from("approval_workflow_steps")
    .select("*")
    .eq("workflow_id", invoice.workflow_id)
    .eq("step_order", invoice.current_step_order)
    .maybeSingle();
  if (!currentStep) return;
  const requiredApproverIds = await requiredApproversFor(
    supabase,
    currentStep,
    invoice
  );
  if (!requiredApproverIds.includes(user.id)) return;

  await supabase
    .from("invoices")
    .update({ status: "on_approval", updated_at: new Date().toISOString() })
    .eq("id", invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.unheld",
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Back to Review: return a non-approved invoice to the Pending Review
// queue. Approval decisions are reset (the workflow re-runs from step 1)
// but the audit trail is preserved.
export async function backToReview(invoiceId: string) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  const { data: inv } = await supabase
    .from("invoices")
    .select("id, organization_id")
    .eq("id", invoiceId)
    .single();
  if (!inv) return;

  await supabase
    .from("invoices")
    .update({
      status: "on_review",
      current_step_order: 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  // Reset approval decisions so the workflow re-runs cleanly.
  await supabase
    .from("invoice_approvals")
    .delete()
    .eq("invoice_id", invoiceId);

  // Audit trail remains.
  await supabase.from("audit_log").insert({
    organization_id: inv.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.back_to_review",
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Cancel: the person who submitted the invoice, or an admin, withdraws it
// before a decision is made. Terminal, like approved/rejected — nothing can
// move a cancelled invoice back into the workflow.
export async function cancelInvoice(invoiceId: string) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, status, submitted_by")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;
  if (
    invoice.status !== "on_review" &&
    invoice.status !== "on_approval" &&
    invoice.status !== "on_hold"
  ) {
    return;
  }

  const isOwner = invoice.submitted_by === user.id;
  const isAdmin = await canReview(supabase);
  if (!isOwner && !isAdmin) return;

  await supabase
    .from("invoices")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.cancelled",
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Admin-only: permanently delete an invoice — the record, its line items,
// documents, comments, and approvals (all cascade, see migration 0001/
// 0003/0005), and its files in Storage. Unlike Cancel (a reversible status
// change anyone who submitted it can also do), this is destructive and
// irreversible, so it's gated to admins and requires a client-side confirm
// (ConfirmSubmitButton). The audit_log row logging the deletion is written
// BEFORE the delete and survives it (invoice_id becomes null via ON DELETE
// SET NULL, migration 0022) so the deletion itself stays traceable.
export async function deleteInvoiceAction(invoiceId: string) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, file_path, vendor_name, invoice_number")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;

  const { data: docs } = await supabase
    .from("invoice_documents")
    .select("file_path")
    .eq("invoice_id", invoiceId);
  const filePaths = [invoice.file_path, ...(docs ?? []).map((d) => d.file_path)];

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.deleted",
    metadata: {
      vendor_name: invoice.vendor_name,
      invoice_number: invoice.invoice_number,
    },
  });

  const { error: deleteError } = await supabase
    .from("invoices")
    .delete()
    .eq("id", invoiceId);
  if (deleteError) throw deleteError;

  await supabase.storage.from("invoices").remove(filePaths);

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
  redirect("/dashboard");
}

// Admin-only: push this one invoice to a different approver for its current
// step, without touching the shared approval_workflow_steps template (which
// would silently reassign every other invoice on that workflow too). Only
// meaningful while there's an active step; clears automatically once the
// step is decided (see decide()) or the invoice leaves on_approval/on_hold
// (see overrideStatus()). Empty selection clears the override.
export async function reassignApprover(invoiceId: string, formData: FormData) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, status")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;
  if (invoice.status !== "on_approval" && invoice.status !== "on_hold") return;

  const approverId = String(formData.get("approver_id") ?? "").trim() || null;

  const { error: updateError } = await supabase
    .from("invoices")
    .update({ step_override_approver_id: approverId, updated_at: new Date().toISOString() })
    .eq("id", invoiceId);
  if (updateError) throw updateError;

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.reassigned",
    metadata: { approver_id: approverId },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Admin-only: force the invoice to any status directly, bypassing the
// normal step-by-step gate. Doesn't fabricate an invoice_approvals row for
// whatever step got skipped — that would misrepresent who actually decided
// it — the audit_log entry is the honest record of the override. Moving to
// on_review resets the workflow from step 1 (mirrors backToReview); moving
// away from on_approval/on_hold clears any per-invoice reassignment, since
// it's no longer meaningful outside those two statuses.
// Status options for the admin status override (kept in sync with the
// render-side list in the dashboard page).
const STATUS_OPTIONS: { id: string; label: string }[] = [
  { id: "on_review", label: "On review" },
  { id: "on_approval", label: "On approval" },
  { id: "approved", label: "Approved" },
  { id: "cancelled", label: "Cancelled" },
  { id: "rejected", label: "Rejected" },
  { id: "on_hold", label: "On hold" },
];

export async function overrideStatus(invoiceId: string, formData: FormData) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  const newStatus = String(formData.get("status") ?? "") as InvoiceStatus;
  if (!STATUS_OPTIONS.some((s) => s.id === newStatus)) return;

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, status")
    .eq("id", invoiceId)
    .single();
  if (!invoice || invoice.status === newStatus) return;

  const update: Database["public"]["Tables"]["invoices"]["Update"] = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (newStatus !== "on_approval" && newStatus !== "on_hold") {
    update.step_override_approver_id = null;
  }
  if (newStatus === "on_review") {
    update.current_step_order = 1;
    await supabase.from("invoice_approvals").delete().eq("invoice_id", invoiceId);
  }

  const { error: updateError } = await supabase
    .from("invoices")
    .update(update)
    .eq("id", invoiceId);
  if (updateError) throw updateError;

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.admin_override_status",
    metadata: { from: invoice.status, to: newStatus },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Create or update one category-details line item.
export async function saveLineItem(
  invoiceId: string,
  lineItemId: string,
  formData: FormData
) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select("organization_id")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;

  const text = (key: string) =>
    String(formData.get(key) ?? "").trim() || null;
  const num = (key: string) => {
    const raw = String(formData.get(key) ?? "").replace(/,/g, "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const values = {
    category: text("category"),
    description: text("description"),
    tax_rate: num("tax_rate"),
    qbo_tax_code_id: text("qbo_tax_code_id"),
    class: text("class"),
    project_id: text("project_id"),
    amount: num("amount"),
    linked: formData.get("linked") === "on",
  };

  const isNew = lineItemId === "new";
  if (isNew) {
    const { data: last } = await supabase
      .from("invoice_line_items")
      .select("line_order")
      .eq("invoice_id", invoiceId)
      .order("line_order", { ascending: false })
      .limit(1);
    await supabase.from("invoice_line_items").insert({
      ...values,
      invoice_id: invoiceId,
      line_order: (last?.[0]?.line_order ?? 0) + 1,
    });
  } else {
    // Load the current values so the audit records EXACTLY what changed
    // (from → to) instead of a generic "line edited".
    const { data: before } = await supabase
      .from("invoice_line_items")
      .select("description, category, class, project_id, tax_rate, qbo_tax_code_id, amount")
      .eq("id", lineItemId)
      .single();

    await supabase
      .from("invoice_line_items")
      .update(values)
      .eq("id", lineItemId);

    if (before) {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const fields = [
        "description",
        "category",
        "class",
        "project_id",
        "tax_rate",
        "amount",
      ] as const;
      for (const f of fields) {
        const from = before[f] ?? null;
        const to = values[f] ?? null;
        if (String(from) !== String(to)) changes[f] = { from, to };
      }
      if (Object.keys(changes).length > 0) {
        await supabase.from("audit_log").insert({
          organization_id: invoice.organization_id,
          invoice_id: invoiceId,
          actor_id: user.id,
          action: "invoice.line_item_edited",
          metadata: { changes },
        });
      }
    }
  }

  await recomputeInvoiceTotals(supabase, invoiceId);

  if (isNew) {
    await supabase.from("audit_log").insert({
      organization_id: invoice.organization_id,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "invoice.line_item_added",
      metadata: {
        description: values.description,
        category: values.category,
        amount: values.amount,
      },
    });
  }

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

export async function deleteLineItem(invoiceId: string, lineItemId: string) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select("organization_id")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;

  const { data: item } = await supabase
    .from("invoice_line_items")
    .select("description, category, amount")
    .eq("id", lineItemId)
    .single();

  await supabase.from("invoice_line_items").delete().eq("id", lineItemId);

  await recomputeInvoiceTotals(supabase, invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.line_item_deleted",
    metadata: {
      description: item?.description ?? null,
      category: item?.category ?? null,
      amount: item?.amount ?? null,
    },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Duplicate a line item exactly (same category/description/tax/class/
// project/amount) as a new row right after it — the fast path for "one
// more line just like this one", instead of re-typing everything into
// the blank add-line row.
export async function cloneLineItem(invoiceId: string, lineItemId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select("organization_id")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;

  const { data: item } = await supabase
    .from("invoice_line_items")
    .select("category, description, tax_rate, qbo_tax_code_id, class, project_id, amount, linked, line_order")
    .eq("id", lineItemId)
    .single();
  if (!item) return;

  const { data: last } = await supabase
    .from("invoice_line_items")
    .select("line_order")
    .eq("invoice_id", invoiceId)
    .order("line_order", { ascending: false })
    .limit(1);

  await supabase.from("invoice_line_items").insert({
    category: item.category,
    description: item.description,
    tax_rate: item.tax_rate,
    qbo_tax_code_id: item.qbo_tax_code_id,
    class: item.class,
    project_id: item.project_id,
    amount: item.amount,
    linked: item.linked,
    invoice_id: invoiceId,
    line_order: (last?.[0]?.line_order ?? 0) + 1,
  });

  await recomputeInvoiceTotals(supabase, invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.line_item_added",
    metadata: {
      description: item.description,
      category: item.category,
      amount: item.amount,
      cloned: true,
    },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
}

// Shared core of re-extraction: downloads the invoice's primary document,
// re-runs extraction, replaces the mapped fields + line items. Used by the
// Re-extract button and by page reordering (which re-extracts after the
// pages are rearranged). Best-effort — returns false on any failure.
async function reExtractInvoiceCore(
  supabase: ReturnType<typeof createClient>,
  invoiceId: string,
  actorId: string
): Promise<boolean> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, file_path, file_name, has_cos_or_extras")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return false;

  // Storage can lag a moment behind a just-finished write (e.g. Reorder
  // pages re-uploaded the PDF in place) — retry the download briefly
  // instead of failing the re-extract silently.
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await supabase.storage
      .from("invoices")
      .download(invoice.file_path);
    if (res.data) {
      blob = res.data;
      break;
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!blob) return false;

  const ext = invoice.file_name.split(".").pop()?.toLowerCase() ?? "";
  const mime =
    ext === "pdf"
      ? "application/pdf"
      : ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : "application/octet-stream";
  const file = new File([blob], invoice.file_name, { type: mime });

  const extracted = await extractInvoiceFields(file);
  if (!extracted) return false;

  await supabase
    .from("invoices")
    .update({
      ...mapExtractionToInvoice(extracted),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  // Replace the extracted line items (Category details in the Bill panel).
  // PROJECT is a human decision: it may have been auto-filled from the PO
  // number at ingest, but once the user changes it, re-extraction must
  // NEVER revert it. Preserve each existing line's project_id by line
  // order onto the freshly-extracted lines.
  const { data: existingLines } = await supabase
    .from("invoice_line_items")
    .select("line_order, project_id")
    .eq("invoice_id", invoiceId)
    .order("line_order", { ascending: true });
  const projectByOrder = new Map(
    (existingLines ?? []).map((l) => [l.line_order, l.project_id])
  );

  await supabase
    .from("invoice_line_items")
    .delete()
    .eq("invoice_id", invoiceId);
  if (extracted.line_items.length > 0) {
    // Class NEVER comes from the document (the org's classes are totally
    // different). The only exception: an invoice already flagged as
    // CO/Extras keeps its line class "Extras" (that flag is locked once
    // decided, so the class stays with it through re-extraction).
    const lineClass = invoice.has_cos_or_extras === true ? "Extras" : null;
    // Org default tax is a specific CODE (H 13%) — carry it onto lines whose
    // rate matches the default, so the sync doesn't have to guess between
    // duplicate-rate codes.
    const { data: orgDefault } = await supabase
      .from("organizations")
      .select("default_tax_rate, default_tax_code_id")
      .eq("id", invoice.organization_id)
      .single();
    await supabase.from("invoice_line_items").insert(
      extracted.line_items.map((li, i) => ({
        invoice_id: invoiceId,
        description: li.description,
        amount:
          holdbackCategoryFor(li) && (li.amount ?? 0) > 0
            ? -(li.amount ?? 0)
            : li.amount,
        tax_rate: li.tax_rate,
        qbo_tax_code_id:
          orgDefault?.default_tax_code_id != null &&
          li.tax_rate != null &&
          orgDefault.default_tax_rate != null &&
          Math.abs(li.tax_rate - orgDefault.default_tax_rate) < 0.005
            ? orgDefault.default_tax_code_id
            : null,
        category: holdbackCategoryFor(li) ?? li.category,
        class: lineClass,
        project_id: projectByOrder.get(i + 1) ?? null,
        line_order: i + 1,
      }))
    );
  }

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: actorId,
    action: "invoice.re_extracted",
  });

  return true;
}

// Re-run extraction on the invoice's primary document and replace the
// mapped fields + line items (Dext-style "re-process"). Best-effort.
export async function reExtract(invoiceId: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await reExtractInvoiceCore(supabase, invoiceId, user.id);
  revalidateTag(INVOICES_TAG);
  revalidatePath("/dashboard", "layout");
}

// How many pages the invoice's primary document has (for the Reorder pages
// UI). Returns null for non-PDFs or on failure.
export async function getInvoicePageCount(
  invoiceId: string
): Promise<number | null> {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, file_path, file_name")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return null;
  if (!invoice.file_name.toLowerCase().endsWith(".pdf")) return null;

  // Retry the download briefly — storage can lag a moment behind a
  // just-finished reorder, and a stale page count is what breaks the
  // Reorder/delete modal's page list.
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await supabase.storage
      .from("invoices")
      .download(invoice.file_path);
    if (res.data) {
      blob = res.data;
      break;
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!blob) return null;

  return pdfPageCount(new Uint8Array(await blob.arrayBuffer())) || null;
}

// Reorder the pages of the invoice's primary PDF (1-based page numbers, a
// full permutation of 1..N), re-upload it, and re-extract the fields from
// the new page order — the in-app replacement for merging/ordering pages in
// an external tool. Admin/reviewer only.
export async function reorderInvoicePages(
  invoiceId: string,
  order: number[]
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!(await canReview(supabase))) {
    return { ok: false, error: "Only the reviewer can reorder pages." };
  }

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, file_path, file_name")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  if (!invoice.file_name.toLowerCase().endsWith(".pdf")) {
    return { ok: false, error: "Only PDF documents can be reordered." };
  }

  const { data: blob, error: downloadError } = await supabase.storage
    .from("invoices")
    .download(invoice.file_path);
  if (downloadError || !blob) return { ok: false, error: "Could not read the document." };

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const reordered = await reorderPdfPages(bytes, order);
  if (!reordered) {
    const currentPages = pdfPageCount(bytes);
    return {
      ok: false,
      error: `Invalid page list — the document currently has ${currentPages} page${currentPages === 1 ? "" : "s"}; list the pages you want to keep, in order, each once (e.g. 2, 1).`,
    };
  }

  // Replace the document in place (same path, so the document row and audit
  // references stay valid).
  const saveStartedAt = Date.now();
  const { error: uploadError } = await supabase.storage
    .from("invoices")
    .upload(invoice.file_path, reordered, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) {
    return { ok: false, error: `Could not save the reordered document: ${uploadError.message}` };
  }

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.pages_reordered",
    metadata: { order },
  });

  // Storage can lag a moment behind a write — give the save a settle window
  // sized from how long the upload itself took (a fast save waits the
  // remainder of ~1s; a slow one is already settled), before re-extracting.
  const settleMs = Math.max(0, 1000 - (Date.now() - saveStartedAt));
  if (settleMs > 0) {
    await new Promise((r) => setTimeout(r, settleMs));
  }

  // No auto re-extraction after page changes — that stays a manual
  // "Re-extract document fields" step (the PDF is rebuilt in the new order;
  // the user re-extracts when they want the fields refreshed).

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
  return { ok: true };
}


// Save the org's default tax rate for new invoices. Admin only. The value
// is one of the synced QBO tax code rates (e.g. 13 for H 13%); applied at
// ingestion when the supplier has no rule of their own.
export async function saveDefaultTaxRate(formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    redirect("/settings?taxdefault=error");
  }

  // The setting is a specific QBO tax CODE (e.g. H 13%) — duplicate-rate
  // codes (H vs M&E (ON), both 13%) can't be guessed at sync time, so we
  // store the code and its rate together.
  const rawCode = String(formData.get("default_tax_code_id") ?? "").trim();
  let rate: number | null = null;
  if (rawCode !== "") {
    const { data: code } = await supabase
      .from("qbo_tax_codes")
      .select("rate_value")
      .eq("organization_id", org.id)
      .eq("qbo_tax_code_id", rawCode)
      .single();
    if (!code || code.rate_value == null) {
      redirect("/settings?taxdefault=error");
    }
    rate = Number(code.rate_value);
  }

  // Never claim success when the write didn't land (e.g. RLS denied it) —
  // otherwise Settings shows the banner while the rate stays unsaved.
  const { error: updateError } = await supabase
    .from("organizations")
    .update({ default_tax_rate: rate, default_tax_code_id: rawCode || null })
    .eq("id", org.id);
  if (updateError) {
    console.error("saveDefaultTaxRate failed:", updateError);
    redirect("/settings?taxdefault=error");
  }

  const { error: auditError } = await supabase.from("audit_log").insert({
    organization_id: org.id,
    actor_id: user.id,
    action: "org.default_tax_rate_saved",
    metadata: { default_tax_code_id: rawCode || null, default_tax_rate: rate },
  });
  if (auditError) console.error("saveDefaultTaxRate audit failed:", auditError);

  revalidatePath("/settings");
  redirect(
    rate != null
      ? `/settings?taxdefault=saved&rate=${rate}`
      : "/settings?taxdefault=cleared"
  );
}


// Set (or clear) the org's friendly inbound-email local part — the
// ApprovalMax/Dext model: clients email invoices to
// {local}@{INBOUND_EMAIL_DOMAIN} (e.g. fluid@flow.ufirst.co) on OUR domain,
// with nothing to set up on their side. Admin only. Returns a result object
// so the form can show inline errors (uniqueness/format) without a page
// navigation.
export async function saveInboundEmailLocal(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    return { ok: false, error: "Only the org admin can change this." };
  }

  const raw = String(formData.get("inbound_email_local") ?? "")
    .trim()
    .toLowerCase();
  const value = raw === "" ? null : raw;

  if (value && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    return {
      ok: false,
      error:
        'Use lowercase letters, numbers, dashes, dots or underscores — e.g. "fluidconstruction".',
    };
  }

  if (value) {
    const { data: existing } = await supabase
      .from("organizations")
      .select("id")
      .eq("inbound_email_local", value)
      .neq("id", org.id)
      .maybeSingle();
    if (existing) {
      return {
        ok: false,
        error: `"${value}@${process.env.INBOUND_EMAIL_DOMAIN ?? "…"}" is already taken by another company.`,
      };
    }
  }

  const { error: updateError } = await supabase
    .from("organizations")
    .update({ inbound_email_local: value })
    .eq("id", org.id);
  if (updateError) {
    console.error("saveInboundEmailLocal failed:", updateError);
    return { ok: false, error: "Could not save — please try again." };
  }

  await supabase.from("audit_log").insert({
    organization_id: org.id,
    actor_id: user.id,
    action: "org.inbound_email_local_saved",
    metadata: { inbound_email_local: value },
  });

  revalidatePath("/settings");
  revalidateTag(INVOICES_TAG);
  revalidatePath("/dashboard", "layout");
  return { ok: true };
}

// Remove a bad message from the Queue (spam, tests, wrong recipient).
// Admin only — the page shows the button only to admins, and this action
// re-checks.
export async function deleteInboundEmailLog(id: string): Promise<void> {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") return;

  const { error } = await supabase
    .from("inbound_email_log")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.id);
  if (error) console.error("deleteInboundEmailLog failed:", error);

  revalidatePath("/queue");
}

// Remove a bad upload entry from the Queue. Admin only.
export async function deleteUploadLogEntry(id: string): Promise<void> {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") return;

  const { error } = await supabase
    .from("upload_log")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.id);
  if (error) console.error("deleteUploadLogEntry failed:", error);

  revalidatePath("/queue");
}

// Admin bulk cleanup for the Queue: removes all COMPLETED entries (emails
// that became invoices/split reviews, uploads that finished) so the queue
// stays short. Failed / unmatched entries stay visible for attention.
// Re-run a failed / "no invoice data" ingest job from the Queue — re-queues
// it (the staging file is kept for exactly this) and resets its display row
// so the poller picks it up with the current logic. Admin only.
export async function reprocessIngestJob(jobId: string): Promise<void> {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") return;

  const { data: job } = await supabase
    .from("ingest_jobs")
    .select("id, organization_id, upload_log_id, inbound_email_log_id, status")
    .eq("id", jobId)
    .single();
  if (!job || job.organization_id !== org.id) return;

  const now = new Date().toISOString();
  await supabase
    .from("ingest_jobs")
    .update({ status: "queued", attempt_count: 0, last_error: null, processed_at: null, updated_at: now })
    .eq("id", jobId);

  if (job.upload_log_id) {
    await supabase
      .from("upload_log")
      .update({ status: "queued", error: null, processed_at: null })
      .eq("id", job.upload_log_id);
  }
  if (job.inbound_email_log_id) {
    await supabase
      .from("inbound_email_log")
      .update({ processing: true, processed: false, error: null })
      .eq("id", job.inbound_email_log_id);
  }

  revalidateTag(INVOICES_TAG);
  revalidatePath("/queue");
}

export async function clearCompletedQueue(): Promise<void> {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") return;

  // ONLY fully-processed items: uploads that became an invoice (done) and
  // emails that produced at least one invoice. Everything still needing a
  // look stays — queued/processing/error uploads, unmatched/failed/
  // processing emails, and SPLIT-REVIEW entries (both kinds) survive,
  // because the split still awaits human review.
  const [emailRes, uploadRes] = await Promise.all([
    supabase
      .from("inbound_email_log")
      .delete()
      .eq("organization_id", org.id)
      .eq("processed", true)
      .filter("invoice_ids", "neq", "{}"),
    supabase
      .from("upload_log")
      .delete()
      .eq("organization_id", org.id)
      .eq("status", "done"),
  ]);
  if (emailRes.error) console.error("clearCompletedQueue emails:", emailRes.error);
  if (uploadRes.error) console.error("clearCompletedQueue uploads:", uploadRes.error);

  revalidatePath("/queue");
}

// Record when a QBO mirror section was last synced — Settings shows
// "N on File. Last synced on <time>" per section and lists only the items
// that are NEW in the most recent sync (rows whose first_seen_at is >= this
// timestamp). Written BEFORE the upserts so the window covers this run;
// failures are logged but never fail the sync itself.
async function recordQboSync(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  section: "taxes" | "classes" | "categories" | "suppliers" | "projects",
  at: string
) {
  const { error } = await supabase
    .from("qbo_sync_log")
    .upsert(
      { organization_id: orgId, section, synced_at: at },
      { onConflict: "organization_id,section" }
    );
  if (error) console.error("recordQboSync failed:", error);
}

// Pull QuickBooks tax RATES (the % applied to bills) into the app.
// READ-ONLY against QBO — nothing is ever written to QuickBooks here.
// Admin only. Rates are deduped by percentage (e.g. GST 5%, HST 13%).
export async function syncQboTaxes() {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    redirect("/settings?qbo=error");
  }

  const conn = await getQboConnection(supabase, org.id);
  if (!conn) {
    redirect("/settings?qbo=error");
  }

  let rates: Awaited<ReturnType<typeof listTaxRates>> = [];
  let codes: Awaited<ReturnType<typeof listTaxCodes>> = [];
  try {
    [rates, codes] = await Promise.all([
      listTaxRates(conn),
      listTaxCodes(conn),
    ]);

    await recordQboSync(supabase, org.id, "taxes", new Date().toISOString());

    if (rates.length > 0) {
      const { error } = await supabase.from("qbo_tax_rates").upsert(
        rates.map((r) => ({
          organization_id: org.id,
          qbo_tax_rate_id: r.qboTaxRateId,
          name: r.name,
          rate_value: r.rateValue,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_tax_rate_id" }
      );
      if (error) throw error;
    }

    // Tax codes with their resolved rate — what the bill's Tax field offers
    // ("H" → 13%), exactly like Dext/ApprovalMax.
    if (codes.length > 0) {
      const { error } = await supabase.from("qbo_tax_codes").upsert(
        codes.map((c) => ({
          organization_id: org.id,
          qbo_tax_code_id: c.qboTaxCodeId,
          name: c.name,
          rate_value: c.rateValue,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_tax_code_id" }
      );
      if (error) throw error;
    }
  } catch (e) {
    console.error("syncQboTaxes failed:", e);
    redirect("/settings?qbo=error");
  }

  // NOTE: redirect() throws internally — it must live OUTSIDE the try/catch
  // above, or the catch swallows it and every sync shows the error banner
  // even when it succeeded.
  revalidateTag(qboTag(org.id)); // invalidate the cached QBO mirrors
  revalidatePath("/settings");
  redirect(`/settings?qbo=tax_synced&count=${rates.length + codes.length}`);
}


// Pull QuickBooks CLASSES (project numbers etc.) into the app. READ-ONLY
// against QBO — nothing is ever written to QuickBooks here. Admin only.
// New classes added in QBO show up in Flow after a sync.
export async function syncQboClasses() {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    redirect("/settings?qbo=error");
  }

  const conn = await getQboConnection(supabase, org.id);
  if (!conn) {
    redirect("/settings?qbo=error");
  }

  let classes: Awaited<ReturnType<typeof listClasses>> = [];
  try {
    classes = await listClasses(conn);

    await recordQboSync(supabase, org.id, "classes", new Date().toISOString());

    if (classes.length > 0) {
      const { error } = await supabase.from("qbo_classes").upsert(
        classes.map((c) => ({
          organization_id: org.id,
          qbo_class_id: c.qboClassId,
          name: c.name,
          active: c.active,
          sub_class: c.subClass,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_class_id" }
      );
      if (error) throw error;
    }
  } catch (e) {
    console.error("syncQboClasses failed:", e);
    redirect("/settings?qbo=error");
  }

  // redirect() throws internally — keep it OUTSIDE the try/catch so a
  // successful sync doesn't get mislabeled as a failure.
  revalidateTag(qboTag(org.id)); // invalidate the cached QBO mirrors
  revalidatePath("/settings");
  redirect(`/settings?qbo=classes_synced&count=${classes.length}`);
}


// Pull QuickBooks categories (Chart of Accounts) into the app. READ-ONLY
// against QBO — nothing is ever written to QuickBooks here, and no vendor
// data is fetched. Admin only. Currently pulls only the bill categories:
// Division 5 & 6 (AcctNum starting with 5 or 6).
export async function syncQboCategories() {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    redirect("/settings?qbo=error");
  }

  const conn = await getQboConnection(supabase, org.id);
  if (!conn) {
    redirect("/settings?qbo=error");
  }

  let categories: Awaited<ReturnType<typeof listCategories>> = [];
  try {
    // Bill categories: account numbers starting with 2, 5, or 6 (payables,
    // materials/COGS, expenses — the numbered chart of accounts).
    categories = await listCategories(conn, 500, {
      acctNumPrefixes: ["2", "5", "6"],
    });

    await recordQboSync(supabase, org.id, "categories", new Date().toISOString());

    if (categories.length > 0) {
      const { error } = await supabase.from("qbo_categories").upsert(
        categories.map((c) => ({
          organization_id: org.id,
          qbo_account_id: c.qboAccountId,
          name: c.name,
          acct_num: c.acctNum,
          account_type: c.accountType,
          account_sub_type: c.accountSubType,
          active: c.active,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_account_id" }
      );
      if (error) throw error;
    }
  } catch (e) {
    console.error("syncQboCategories failed:", e);
    redirect("/settings?qbo=error");
  }

  // redirect() throws internally — keep it OUTSIDE the try/catch so a
  // successful sync doesn't get mislabeled as a failure.
  revalidateTag(qboTag(org.id)); // invalidate the cached QBO mirrors
  revalidatePath("/settings");
  redirect(`/settings?qbo=categories_synced&count=${categories.length}`);
}


// Pull QuickBooks SUPPLIERS (Vendor list) into the app. READ-ONLY against
// QBO — Flow never creates suppliers in QuickBooks; this mirror is what OCR
// matching and bill sync run against. Admin only.
export async function syncQboSuppliers() {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    redirect("/settings?qbo=error");
  }

  const conn = await getQboConnection(supabase, org.id);
  if (!conn) {
    redirect("/settings?qbo=error");
  }

  let suppliers: Awaited<ReturnType<typeof listSuppliers>> = [];
  try {
    suppliers = await listSuppliers(conn);

    await recordQboSync(supabase, org.id, "suppliers", new Date().toISOString());

    if (suppliers.length > 0) {
      const { error } = await supabase.from("qbo_suppliers").upsert(
        suppliers.map((s) => ({
          organization_id: org.id,
          qbo_vendor_id: s.qboVendorId,
          name: s.name,
          name_normalized: s.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim(),
          active: s.active,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_vendor_id" }
      );
      if (error) throw error;
    }
  } catch (e) {
    console.error("syncQboSuppliers failed:", e);
    redirect("/settings?qbo=error");
  }

  // redirect() throws internally — keep it OUTSIDE the try/catch so a
  // successful sync doesn't get mislabeled as a failure.
  revalidateTag(qboTag(org.id)); // invalidate the cached QBO mirrors
  revalidatePath("/settings");
  redirect(`/settings?qbo=suppliers_synced&count=${suppliers.length}`);
}


// Pull QuickBooks PROJECTS into the app's projects table. READ-ONLY against
// QBO — projects are QBO customers with IsProject=true (regular customers
// are NOT imported). Admin only.
export async function syncQboProjects() {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    redirect("/settings?qbo=error");
  }

  const conn = await getQboConnection(supabase, org.id);
  if (!conn) {
    redirect("/settings?qbo=error");
  }

  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  try {
    projects = await listProjects(conn);

    await recordQboSync(supabase, org.id, "projects", new Date().toISOString());

    if (projects.length > 0) {
      const { error } = await supabase.from("projects").upsert(
        projects.map((p) => ({
          organization_id: org.id,
          qbo_id: p.qboCustomerId,
          name: p.name,
          source: "qbo",
          active: p.active,
        })),
        { onConflict: "organization_id,name" }
      );
      if (error) throw error;
    }
  } catch (e) {
    console.error("syncQboProjects failed:", e);
    redirect("/settings?qbo=error");
  }

  // redirect() throws internally — keep it OUTSIDE the try/catch so a
  // successful sync doesn't get mislabeled as a failure.
  revalidateTag(qboTag(org.id)); // invalidate the cached QBO mirrors
  revalidatePath("/settings");
  redirect(`/settings?qbo=projects_synced&count=${projects.length}`);
}


// One-click refresh: pulls tax rates, classes, categories (Divisions 5 & 6),
// and suppliers from QuickBooks in a single action. READ-ONLY against QBO —
// nothing is ever written to QuickBooks. Admin only.
export async function refreshQboData() {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") {
    redirect("/settings?qbo=error");
  }

  const conn = await getQboConnection(supabase, org.id);
  if (!conn) {
    redirect("/settings?qbo=error");
  }

  try {
    const [rates, codes, classes, categories, suppliers, projects] = await Promise.all([
      listTaxRates(conn),
      listTaxCodes(conn),
      listClasses(conn),
      listCategories(conn, 500, { acctNumPrefixes: ["2", "5", "6"] }),
      listSuppliers(conn),
      listProjects(conn),
    ]);

    // One timestamp for every section, written before the upserts, so each
    // Settings section shows this run as its "Last synced" and lists the
    // items that are new in it.
    const syncNow = new Date().toISOString();
    await Promise.all([
      recordQboSync(supabase, org.id, "taxes", syncNow),
      recordQboSync(supabase, org.id, "classes", syncNow),
      recordQboSync(supabase, org.id, "categories", syncNow),
      recordQboSync(supabase, org.id, "suppliers", syncNow),
      recordQboSync(supabase, org.id, "projects", syncNow),
    ]);

    if (rates.length > 0) {
      const { error } = await supabase.from("qbo_tax_rates").upsert(
        rates.map((r) => ({
          organization_id: org.id,
          qbo_tax_rate_id: r.qboTaxRateId,
          name: r.name,
          rate_value: r.rateValue,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_tax_rate_id" }
      );
      if (error) throw error;
    }

    if (codes.length > 0) {
      const { error } = await supabase.from("qbo_tax_codes").upsert(
        codes.map((c) => ({
          organization_id: org.id,
          qbo_tax_code_id: c.qboTaxCodeId,
          name: c.name,
          rate_value: c.rateValue,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_tax_code_id" }
      );
      if (error) throw error;
    }

    if (suppliers.length > 0) {
      const { error } = await supabase.from("qbo_suppliers").upsert(
        suppliers.map((s) => ({
          organization_id: org.id,
          qbo_vendor_id: s.qboVendorId,
          name: s.name,
          name_normalized: s.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
          active: s.active,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_vendor_id" }
      );
      if (error) throw error;
    }

    if (classes.length > 0) {
      const { error } = await supabase.from("qbo_classes").upsert(
        classes.map((c) => ({
          organization_id: org.id,
          qbo_class_id: c.qboClassId,
          name: c.name,
          active: c.active,
          sub_class: c.subClass,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_class_id" }
      );
      if (error) throw error;
    }

    if (categories.length > 0) {
      const { error } = await supabase.from("qbo_categories").upsert(
        categories.map((c) => ({
          organization_id: org.id,
          qbo_account_id: c.qboAccountId,
          name: c.name,
          acct_num: c.acctNum,
          account_type: c.accountType,
          account_sub_type: c.accountSubType,
          active: c.active,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "organization_id,qbo_account_id" }
      );
      if (error) throw error;
    }

    if (projects.length > 0) {
      const { error } = await supabase.from("projects").upsert(
        projects.map((p) => ({
          organization_id: org.id,
          qbo_id: p.qboCustomerId,
          name: p.name,
          source: "qbo",
          active: p.active,
        })),
        { onConflict: "organization_id,name" }
      );
      if (error) throw error;
    }

    const total =
      rates.length + suppliers.length + classes.length + categories.length + projects.length;
    revalidateTag(qboTag(org.id)); // invalidate the cached QBO mirrors
    revalidatePath("/settings");
    redirect(`/settings?qbo=refresh_done&count=${total}`);
  } catch (e) {
    console.error("refreshQboData failed:", e);
    redirect("/settings?qbo=error");
  }
}


// Sync an invoice's bill to QuickBooks Online (admin only). Creates the
// bill (line items, tax, memo/PrivateNote from the accounting
// instructions) and attaches the audit-trail PDF plus every invoice
// document.
//
// HARD RULES (business invariants, enforced here and nowhere overridable):
//   1. Approval gate — a bill is NEVER sent to QBO until the invoice has
//      completed EVERY step of its approval workflow (status === "approved"
//      only happens when the final step passes).
//   2. No supplier creation — the vendor is matched to an existing QBO
//      supplier from the read-only qbo_suppliers mirror. If there is no
//      close match the sync fails with a clear message; Flow never creates
//      a supplier in QuickBooks.
// Errors are recorded on the invoice (qbo_sync_status='error').
export async function syncToQbo(invoiceId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  const { data: inv } = await supabase
    .from("invoices")
    .select(
      "id, organization_id, vendor_name, invoice_number, bill_date, due_date, currency, tax_amount, status, created_at"
    )
    .eq("id", invoiceId)
    .single();
  if (!inv || !inv.vendor_name) return;

  const fail = async (message: string) => {
    await supabase
      .from("invoices")
      .update({
        qbo_sync_status: "error",
        qbo_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoiceId);
    await supabase.from("audit_log").insert({
      organization_id: inv.organization_id,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "invoice.qbo_sync_failed",
      metadata: { error: message },
    });
  };

  // RULE 1 — approval gate: only a bill that has completed every workflow
  // step (status 'qbo_ready') may sync — and only an admin can press the
  // final button (enforced by the caller UI + canReview).
  if (inv.status !== "qbo_ready") {
    await fail(
      "This bill cannot sync to QuickBooks yet — it must complete every step of the approval workflow and be released by an admin."
    );
    revalidateTag(INVOICES_TAG);
    revalidatePath("/dashboard", "layout");
    revalidatePath("/settings");
    return;
  }

  const conn = await getQboConnection(supabase, inv.organization_id);
  if (!conn) {
    await fail("QuickBooks is not connected — connect it in Settings.");
    revalidateTag(INVOICES_TAG);
    revalidatePath("/dashboard", "layout");
    revalidatePath("/settings");
    return;
  }

  try {
    // RULE 2 — resolve the supplier from the read-only QBO mirror; never
    // create one. The mirror is refreshed via Settings → Refresh data.
    // Paginated: PostgREST caps at 1000 rows, and the mirror has 2,045 —
    // a truncated list would mismatch suppliers past the first 1000.
    const suppliers = await fetchAllQboSuppliers(
      supabase,
      inv.organization_id
    );
    const matchedName = matchSupplier(suppliers, inv.vendor_name);
    if (!matchedName) {
      await fail(
        `Vendor "${inv.vendor_name}" does not exactly match any QuickBooks supplier. Pick the correct supplier from the Vendor list on the bill (or add it in QuickBooks and run Refresh data in Settings), then try again.`
      );
      revalidateTag(INVOICES_TAG);
      revalidatePath("/dashboard", "layout");
      revalidatePath("/settings");
      return;
    }
    const { data: matchedVendor } = await supabase
      .from("qbo_suppliers")
      .select("qbo_vendor_id")
      .eq("organization_id", inv.organization_id)
      .eq("name", matchedName)
      .maybeSingle();
    if (!matchedVendor) {
      await fail(`Could not resolve the QBO supplier id for "${matchedName}".`);
      revalidateTag(INVOICES_TAG);
      revalidatePath("/dashboard", "layout");
      revalidatePath("/settings");
      return;
    }

    const [{ data: lineItems }, { data: instrRows }] = await Promise.all([
      supabase
        .from("invoice_line_items")
        .select("description, amount, category, tax_rate, qbo_tax_code_id, class, project_id")
        .eq("invoice_id", invoiceId),
      supabase
        .from("accounting_instructions")
        .select("author_id, body")
        .eq("invoice_id", invoiceId)
        .order("created_at", { ascending: true }),
    ]);

    // The QBO memo is the full accounting-instructions thread — every
    // approver's line, oldest first, so accountants see the whole trail in
    // QBO reports (not just the latest note).
    const instrAuthorIds = [
      ...new Set(
        (instrRows ?? [])
          .map((r) => r.author_id)
          .filter((id): id is string => !!id)
      ),
    ];
    const { data: instrProfiles } =
      instrAuthorIds.length > 0
        ? await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", instrAuthorIds)
        : { data: [] };
    const instrName = new Map(
      (instrProfiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
    );
    // Consecutive messages from the same author collapse onto one line,
    // named once, with their bodies comma-separated — e.g.
    // "Ali Raza: hello, Bill 5%, ok" instead of a separate "Name: " line
    // per message.
    const memoGroups: { name: string; bodies: string[] }[] = [];
    let lastAuthorKey: string | null = null;
    for (const r of instrRows ?? []) {
      const name = r.author_id ? (instrName.get(r.author_id) ?? "Team member") : "System";
      const key = r.author_id ?? "system";
      if (key === lastAuthorKey) {
        memoGroups[memoGroups.length - 1].bodies.push(r.body);
      } else {
        memoGroups.push({ name, bodies: [r.body] });
        lastAuthorKey = key;
      }
    }
    const memo =
      memoGroups.map((g) => `${g.name}: ${g.bodies.join(", ")}`).join("\n") || undefined;

    // Resolve every line's category to a QBO account id BEFORE building
    // the bill — never inside createBill, and never via a live QBO query
    // for a numbered category (QBO's query language doesn't support
    // filtering by AcctNum at all — see resolveCategoryAccount). One
    // shared cache means at most one refresh-from-QBO for the whole bill,
    // no matter how many lines miss.
    const categoryCache = await loadCategoryAccountCache(supabase, inv.organization_id);
    const taxCodeCache = await loadTaxCodeCache(supabase, inv.organization_id);
    const classCache = await loadClassCache(supabase, inv.organization_id);
    // Project → QBO Customer/Job id is a direct lookup, not a name match:
    // Flow's own projects table already stores the synced QBO id
    // (projects.qbo_id) on each row. A manually-created project (never
    // synced from QBO) has no qbo_id — its lines just get no CustomerRef.
    const projectIds = [
      ...new Set((lineItems ?? []).map((li) => li.project_id).filter((id): id is string => !!id)),
    ];
    const { data: projectRows } =
      projectIds.length > 0
        ? await supabase.from("projects").select("id, qbo_id").in("id", projectIds)
        : { data: [] };
    const qboCustomerIdByProject = new Map(
      (projectRows ?? []).map((p) => [p.id, p.qbo_id])
    );
    const resolvedLines = [];
    for (const li of lineItems ?? []) {
      const accountId = await resolveCategoryAccount(
        supabase,
        conn,
        inv.organization_id,
        categoryCache,
        li.category
      );
      // Only lines where the user actually picked a tax rate get a
      // TaxCodeRef — QBO calculates and posts the tax itself from there.
      // No rate selected means no tax code and nothing else added.
      const taxCodeId = await resolveTaxCode(
        supabase,
        conn,
        inv.organization_id,
        taxCodeCache,
        li.tax_rate,
        li.qbo_tax_code_id
      );
      const classId = await resolveClass(supabase, conn, inv.organization_id, classCache, li.class);
      const customerId = li.project_id ? (qboCustomerIdByProject.get(li.project_id) ?? null) : null;
      resolvedLines.push({
        description: li.description,
        amount: li.amount ?? 0,
        accountId,
        taxCodeId,
        classId,
        customerId,
      });
    }

    const bill = await createBill(conn, {
      vendorId: matchedVendor.qbo_vendor_id,
      billDate: inv.bill_date ?? inv.created_at.slice(0, 10),
      dueDate: inv.due_date ?? undefined,
      currency: inv.currency,
      docNumber: inv.invoice_number,
      memo,
      lines: resolvedLines,
    });

    // The Bill itself already exists in QBO at this point — an attachment
    // failure here must not fail the whole sync (that would mark it as
    // "error" and offer Retry, which would create a SECOND bill). Instead
    // it's recorded as a warning alongside the otherwise-successful sync.
    let attachmentWarning: string | null = null;
    const attachments = await buildQboAttachmentBundle(supabase, invoiceId);
    if (attachments) {
      try {
        await attachDocuments(conn, bill.billId, attachments);
      } catch (e) {
        attachmentWarning = e instanceof Error ? e.message : String(e);
      }
    }

    await supabase
      .from("invoices")
      .update({
        status: "approved", // qbo_ready -> approved once synced to QBO
        qbo_bill_id: bill.billId,
        qbo_sync_status: "synced",
        qbo_synced_at: new Date().toISOString(),
        qbo_error: attachmentWarning,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoiceId);

    await supabase.from("audit_log").insert({
      organization_id: inv.organization_id,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "invoice.qbo_synced",
      metadata: { qbo_bill_id: bill.billId, attachment_warning: attachmentWarning },
    });
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
  revalidatePath("/settings");
}

// Clear a stuck sync error without retrying. syncToQbo only ever touches
// qbo_sync_status/qbo_error, never invoice.status, so a bill that failed
// while qbo_ready and then got sent back to review (or otherwise moved
// on) is left showing a permanently stale "Sync failed" message with no
// way to dismiss it — retrying isn't even offered once the bill is no
// longer qbo_ready. This is the reset valve for that: wipe the error
// fields so the bill goes back to reading as "not synced yet" instead of
// stuck on an error from a previous, no-longer-relevant attempt.
export async function clearQboError(invoiceId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  await supabase
    .from("invoices")
    .update({
      qbo_sync_status: null,
      qbo_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
  revalidatePath("/settings");
}

// Undoes a SUCCESSFUL sync in Flow's own records — for a bill that synced
// with something wrong on it (bad line, wrong tax) and needs to be pushed
// again after a fix, not just an error to dismiss. Only clears Flow's
// side (qbo_sync_status/qbo_bill_id/qbo_synced_at, and status back to
// qbo_ready so it reappears for a re-sync); it does NOT touch, void, or
// delete the Bill that already exists in QuickBooks. Re-syncing after this
// creates a SECOND bill in QBO — the original must be voided/deleted there
// by hand first if it shouldn't stay. Admin only; logged to audit_log
// since undoing a completed financial sync is consequential.
export async function clearQboSync(invoiceId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canReview(supabase))) return;

  const { data: inv } = await supabase
    .from("invoices")
    .select("organization_id, status, qbo_bill_id")
    .eq("id", invoiceId)
    .single();
  if (!inv) return;

  await supabase
    .from("invoices")
    .update({
      qbo_sync_status: null,
      qbo_error: null,
      qbo_bill_id: null,
      qbo_synced_at: null,
      status: inv.status === "approved" ? "qbo_ready" : inv.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: inv.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.qbo_sync_cleared",
    metadata: { previous_qbo_bill_id: inv.qbo_bill_id },
  });

  revalidateTag(INVOICES_TAG);

  revalidatePath("/dashboard", "layout");
  revalidatePath("/settings");
}

// Disconnect the org from QuickBooks (admin only).
export async function disconnectQbo() {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org || org.role !== "admin") return;

  await supabase
    .from("qbo_connections")
    .delete()
    .eq("organization_id", org.id);

  revalidatePath("/settings");
}

