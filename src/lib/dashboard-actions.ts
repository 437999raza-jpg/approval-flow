"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
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
import {
  effectiveApproversForStep,
  stepDecisionState,
} from "@/lib/workflow-conditions";
import type { Database, InvoiceStatus } from "@/lib/supabase/types";
import { getQboConnection, createBill, attachDocuments } from "@/lib/qbo";
import { buildQboAttachmentBundle } from "@/lib/qbo-attachments";

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
  if (instructions) {
    await supabase.from("accounting_instructions").insert({
      invoice_id: invoiceId,
      author_id: user.id,
      body: instructions,
    });
  }

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();
  if (!invoice || !invoice.workflow_id) {
    redirect(`/dashboard/${invoiceId}?error=not-your-step`);
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
    await supabase
      .from("invoices")
      .update({
        status: isFinalStep ? "approved" : "on_approval",
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
  await supabase
    .from("invoices")
    .update({ amount: total, tax_amount: tax, updated_at: new Date().toISOString() })
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

  await supabase
    .from("invoices")
    .update({
      ...next,
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

  revalidatePath("/dashboard", "layout");
}

// Dext/ApprovalMax-style supplier rules: save (upsert, keyed by normalized
// vendor name) and, if requested, retroactively apply Category/Class/
// Project/Tax rate to every line item — and Currency/due date (from
// Payment terms) to the invoice itself — of every other invoice from this
// same supplier still sitting in the review queue. Future invoices from
// this vendor pick up the rule automatically at ingestion (invoices.ts).
export async function saveSupplierDefaults(
  invoiceId: string,
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
    project_id: text("project_id"),
    tax_rate: num("tax_rate"),
    payment_terms_days: int("payment_terms_days"),
    currency: text("currency")?.toUpperCase() ?? null,
  };

  await supabase.from("supplier_defaults").upsert(
    {
      organization_id: org.id,
      vendor_name: vendorName,
      ...values,
      updated_at: new Date().toISOString(),
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
      if (values.project_id) lineItemUpdate.project_id = values.project_id;
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

  revalidatePath("/dashboard", "layout");
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
    await supabase
      .from("invoice_line_items")
      .update(values)
      .eq("id", lineItemId);
  }

  await recomputeInvoiceTotals(supabase, invoiceId);

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: isNew ? "invoice.line_item_added" : "invoice.line_item_edited",
    metadata: {
      description: values.description,
      category: values.category,
      amount: values.amount,
    },
  });

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

  revalidatePath("/dashboard", "layout");
}

// Re-run extraction on the invoice's primary document and replace the
// mapped fields + line items (Dext-style "re-process"). Best-effort.
export async function reExtract(invoiceId: string) {

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, file_path, file_name")
    .eq("id", invoiceId)
    .single();
  if (!invoice) return;

  const { data: blob, error: downloadError } = await supabase.storage
    .from("invoices")
    .download(invoice.file_path);
  if (downloadError || !blob) return;

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
  if (!extracted) return;

  await supabase
    .from("invoices")
    .update({
      ...mapExtractionToInvoice(extracted),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  // Replace the extracted line items (Category details in the Bill panel).
  await supabase
    .from("invoice_line_items")
    .delete()
    .eq("invoice_id", invoiceId);
  if (extracted.line_items.length > 0) {
    await supabase.from("invoice_line_items").insert(
      extracted.line_items.map((li, i) => ({
        invoice_id: invoiceId,
        description: li.description,
        amount: li.amount,
        tax_rate: li.tax_rate,
        category: li.category,
        class: li.class,
        line_order: i + 1,
      }))
    );
  }

  await supabase.from("audit_log").insert({
    organization_id: invoice.organization_id,
    invoice_id: invoiceId,
    actor_id: user.id,
    action: "invoice.re_extracted",
  });

  revalidatePath("/dashboard", "layout");
}


// Sync an invoice's bill to QuickBooks Online (admin only). Creates the
// bill (vendor, line items, tax, memo/PrivateNote from the accounting
// instructions) and attaches the audit-trail PDF plus every invoice
// document. Errors are recorded on the invoice (qbo_sync_status='error').
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
      "id, organization_id, vendor_name, invoice_number, bill_date, due_date, currency, tax_amount, accounting_instructions, created_at"
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

  const conn = await getQboConnection(supabase, inv.organization_id);
  if (!conn) {
    await fail("QuickBooks is not connected — connect it in Settings.");
    revalidatePath("/dashboard", "layout");
    revalidatePath("/settings");
    return;
  }

  try {
    const [{ data: lineItems }, { data: instrRows }] = await Promise.all([
      supabase
        .from("invoice_line_items")
        .select("description, amount, category")
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
    const memo =
      (instrRows ?? [])
        .map(
          (r) =>
            `${r.author_id ? (instrName.get(r.author_id) ?? "Team member") : "System"}: ${r.body}`
        )
        .join("\n") || undefined;

    const bill = await createBill(conn, {
      vendorName: inv.vendor_name,
      billDate: inv.bill_date ?? inv.created_at.slice(0, 10),
      dueDate: inv.due_date ?? undefined,
      currency: inv.currency,
      memo,
      lines: (lineItems ?? []).map((li) => ({
        description: li.description,
        amount: li.amount ?? 0,
        account: li.category,
      })),
      taxAmount: inv.tax_amount ?? 0,
    });

    const attachments = await buildQboAttachmentBundle(supabase, invoiceId);
    if (attachments) {
      await attachDocuments(conn, bill.billId, attachments);
    }

    await supabase
      .from("invoices")
      .update({
        qbo_bill_id: bill.billId,
        qbo_sync_status: "synced",
        qbo_synced_at: new Date().toISOString(),
        qbo_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoiceId);

    await supabase.from("audit_log").insert({
      organization_id: inv.organization_id,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "invoice.qbo_synced",
      metadata: { qbo_bill_id: bill.billId },
    });
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }

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
