// Master-detail dashboard: list + detail panes, approve/reject with
// per-step approver authorization, invoice discussion (chat foundation),
// and the audit-trail document download. Authored by Araza.
import Link from "next/link";
import { clsx } from "clsx";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { sendMentionEmail } from "@/lib/notify";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { SearchInput } from "@/components/SearchInput";
import { SignOutButton } from "@/components/SignOutButton";
import { CollapsiblePane } from "@/components/CollapsiblePane";
import { DetailSplit, type DocumentRef } from "@/components/DetailSplit";
import { Sidebar } from "@/components/Sidebar";
import { DocumentSearchModal, type DocumentSearchFilters } from "@/components/DocumentSearchModal";
import type { SupplierDefaultsValues } from "@/components/SupplierRulesModal";
import type { MultiSelectOption } from "@/components/MultiSelect";
import type { Database, InvoiceStatus } from "@/lib/supabase/types";
import {
  extractInvoiceFields,
  mapExtractionToInvoice,
} from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";
import { computeLineItemTotals } from "@/lib/invoice-totals";
import { buildAuditTimeline } from "@/lib/audit-timeline";
import {
  effectiveApproversForStep,
  stepDecisionState,
  type StepApprover,
  type StepCondition,
} from "@/lib/workflow-conditions";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];

const VIEWS = ["all", "review", "mine", "created", "approved", "rejected"] as const;
type View = (typeof VIEWS)[number];

const STATUS_OPTIONS: MultiSelectOption[] = [
  { id: "on_review", label: "On review" },
  { id: "on_approval", label: "On approval" },
  { id: "approved", label: "Approved" },
  { id: "cancelled", label: "Cancelled" },
  { id: "rejected", label: "Rejected" },
  { id: "on_hold", label: "On hold" },
];

function csvParam(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

const DECISION_ERRORS: Record<string, string> = {
  "not-your-step":
    "Only the approver assigned to the current step can approve or reject this invoice.",
  "already-decided": "This invoice has already been decided at this step.",
  "step-required":
    "Earlier approval steps must be completed before this step can be decided.",
};

// Record a single approve/reject decision for the current workflow step.
// Enforces, in order: signed-in user, invoice visible to the caller's org
// (via RLS on the read), invoice still open, caller is the approver assigned
// to the current step, all prior steps approved, and no decision already
// recorded for this step. The (invoice_id, step_order) unique constraint
// added in migration 0002 makes double-decisions impossible even under a
// race.
//
// Who's actually required to decide the given step for this invoice — a
// step can have several conditionally-matched approvers now (see
// workflow-conditions.ts). An admin reassignment overrides everything to
// just that one person. Shared by every server action that needs to
// check "is this user allowed to act on this step right now".
async function requiredApproversFor(
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
async function decide(
  invoiceId: string,
  decision: "approved" | "rejected",
  formData: FormData
) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const instructions = String(formData.get("instructions") ?? "").trim();
  let instructionsChanged = false;
  if (instructions) {
    const { data: beforeDecide } = await supabase
      .from("invoices")
      .select("accounting_instructions")
      .eq("id", invoiceId)
      .single();
    instructionsChanged =
      (beforeDecide?.accounting_instructions ?? "") !== instructions;
    await supabase
      .from("invoices")
      .update({
        accounting_instructions: instructions,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoiceId);
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

  if (instructionsChanged) {
    await supabase.from("audit_log").insert({
      organization_id: invoice.organization_id,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "invoice.accounting_instructions_edited",
      metadata: { instructions },
    });
  }

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
async function addComment(invoiceId: string, formData: FormData) {
  "use server";

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
async function addDocument(invoiceId: string, formData: FormData) {
  "use server";

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
async function saveAccountingInstructions(
  invoiceId: string,
  formData: FormData
) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const instructions = String(formData.get("instructions") ?? "").trim();

  const { data: before } = await supabase
    .from("invoices")
    .select("organization_id, accounting_instructions")
    .eq("id", invoiceId)
    .single();
  if (!before) return;

  await supabase
    .from("invoices")
    .update({
      accounting_instructions: instructions || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  if ((before.accounting_instructions ?? "") !== instructions) {
    await supabase.from("audit_log").insert({
      organization_id: before.organization_id,
      invoice_id: invoiceId,
      actor_id: user.id,
      action: "invoice.accounting_instructions_edited",
      metadata: { instructions },
    });
  }

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
async function recomputeInvoiceTotals(
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
async function saveBill(invoiceId: string, formData: FormData) {
  "use server";

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
async function saveSupplierDefaults(
  invoiceId: string,
  vendorName: string,
  formData: FormData
) {
  "use server";

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
    const normalized = vendorName.trim().toLowerCase();
    const { data: candidates } = await supabase
      .from("invoices")
      .select("id, bill_date, vendor_name")
      .eq("organization_id", org.id)
      .eq("status", "on_review");

    const matches = (candidates ?? []).filter(
      (i) => i.vendor_name?.trim().toLowerCase() === normalized
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
async function canReview(supabase: ReturnType<typeof createClient>) {
  const org = await getCurrentOrg(supabase);
  return org ? org.role === "admin" : false;
}

// Review Complete: moves an invoice out of the Pending Review queue into
// the approval workflow (status -> pending, workflow re-picked by the rules
// engine now that project/line items may be known). Bill fields save
// themselves on blur, so this action only needs to route.
async function reviewComplete(invoiceId: string) {
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
async function holdInvoice(invoiceId: string) {
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

// Back to Review: return a non-approved invoice to the Pending Review
// queue. Approval decisions are reset (the workflow re-runs from step 1)
// but the audit trail is preserved.
async function backToReview(invoiceId: string) {
  "use server";

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
async function cancelInvoice(invoiceId: string) {
  "use server";

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
async function deleteInvoiceAction(invoiceId: string) {
  "use server";

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
async function reassignApprover(invoiceId: string, formData: FormData) {
  "use server";

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
async function overrideStatus(invoiceId: string, formData: FormData) {
  "use server";

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
async function saveLineItem(
  invoiceId: string,
  lineItemId: string,
  formData: FormData
) {
  "use server";

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

async function deleteLineItem(invoiceId: string, lineItemId: string) {
  "use server";

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
async function reExtract(invoiceId: string) {
  "use server";

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

// File-type helpers for previewing documents (allowed types are pdf, png,
// jpeg, webp — see src/lib/invoices.ts).
const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const isPdfName = (name: string) => extOf(name) === "pdf";
const isImageName = (name: string) =>
  ["png", "jpg", "jpeg", "webp"].includes(extOf(name));

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: { id?: string[] };
  searchParams: {
    view?: string;
    q?: string;
    error?: string;
    status?: string;
    holder?: string;
    requester?: string;
    approvedBy?: string;
    supplier?: string;
    customer?: string;
    class?: string;
    number?: string;
    dateFrom?: string;
    dateTo?: string;
    amountFrom?: string;
    amountTo?: string;
  };
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
          Your account isn&apos;t attached to an organization. Insert a row into
          <code className="mx-1 rounded bg-slate-100 px-1">organizations</code>
          and <code className="mx-1 rounded bg-slate-100 px-1">organization_members</code>
          to get started (see the README).
        </p>
        <div className="mt-4 flex items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="truncate text-slate-600">
            Signed in as <strong>{user.email}</strong>{" "}
            <span className="text-xs text-slate-400">
              (user id {user.id.slice(0, 8)}…)
            </span>
          </span>
          <span className="flex-1" />
          <SignOutButton />
        </div>
      </main>
    );
  }

  const selectedId = params.id?.[0];
  const isAuditor = org.role === "auditor";
  // Review (the Pending Review queue) is admin-only; auditors can view it
  // read-only; users never see pending_review invoices (RLS enforces this
  // at the data level too).
  const canReviewNow = org.role === "admin";
  const canSeeReviewQueue = org.role === "admin" || isAuditor;
  const canEdit = !isAuditor;
  const view: View = VIEWS.includes(searchParams.view as View)
    ? (searchParams.view as View)
    : "all";
  const q = searchParams.q?.trim().toLowerCase() ?? "";

  const [
    { data: invoices },
    { data: workflows },
    { data: projects },
    pendingSplitsRes,
    unreadNotificationsRes,
  ] = await Promise.all([
    supabase
      .from("invoices")
      .select("*")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("approval_workflows")
      .select("id")
      .eq("organization_id", org.id),
    supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", org.id)
      .eq("active", true)
      .order("name", { ascending: true }),
    supabase
      .from("pending_invoice_splits")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .eq("status", "pending"),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("read", false),
  ]);
  const pendingSplitsCount = pendingSplitsRes.count ?? 0;
  const unreadNotificationsCount = unreadNotificationsRes.count ?? 0;

  const workflowIds = (workflows ?? []).map((w) => w.id);
  const invoiceIds = (invoices ?? []).map((i) => i.id);

  // Duplicate detection, org-wide: same (normalized vendor name, invoice
  // number), excluding cancelled/rejected invoices from the pool. Reused
  // for both the per-invoice "Possible duplicate" banner below and for
  // pinning/badging duplicate pairs in the list pane.
  const duplicateGroupKey = (i: Invoice): string | null =>
    i.invoice_number && i.vendor_name
      ? `${i.vendor_name.trim().toLowerCase()}::${i.invoice_number.trim().toLowerCase()}`
      : null;
  const duplicateGroups = new Map<string, Invoice[]>();
  for (const inv of invoices ?? []) {
    if (inv.status === "cancelled" || inv.status === "rejected") continue;
    const key = duplicateGroupKey(inv);
    if (!key) continue;
    if (!duplicateGroups.has(key)) duplicateGroups.set(key, []);
    duplicateGroups.get(key)!.push(inv);
  }
  const duplicateInvoiceIds = new Set<string>();
  for (const group of duplicateGroups.values()) {
    if (group.length > 1) group.forEach((inv) => duplicateInvoiceIds.add(inv.id));
  }

  const { data: allSteps } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_steps")
          .select("*")
          .in("workflow_id", workflowIds)
          .order("step_order", { ascending: true })
      : { data: [] };
  const stepIds = (allSteps ?? []).map((s) => s.id);

  const [
    { data: allStepApprovers },
    { data: memberRows },
    { data: approvedRows },
    { data: lineItemRows },
  ] = await Promise.all([
    stepIds.length > 0
      ? supabase
          .from("approval_workflow_step_approvers")
          .select("*")
          .in("step_id", stepIds)
          .order("row_order", { ascending: true })
      : Promise.resolve({ data: [] }),
    supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id),
    invoiceIds.length > 0
      ? supabase
          .from("invoice_approvals")
          .select("invoice_id, approver_id")
          .in("invoice_id", invoiceIds)
          .eq("decision", "approved")
      : Promise.resolve({ data: [] }),
    invoiceIds.length > 0
      ? supabase
          .from("invoice_line_items")
          .select("invoice_id, class, category, project_id")
          .in("invoice_id", invoiceIds)
      : Promise.resolve({ data: [] }),
  ]);

  const stepApproverIds = (allStepApprovers ?? []).map((a) => a.id);
  const { data: allStepConditions } =
    stepApproverIds.length > 0
      ? await supabase
          .from("approval_workflow_step_conditions")
          .select("*")
          .in("step_approver_id", stepApproverIds)
      : { data: [] };

  const memberUserIds = [...new Set((memberRows ?? []).map((m) => m.user_id))];
  const { data: memberProfiles } =
    memberUserIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", memberUserIds)
      : { data: [] };
  const memberNameById = new Map(
    (memberProfiles ?? []).map((p) => [p.id, p.full_name ?? "Team member"])
  );
  const memberOptions: MultiSelectOption[] = memberUserIds
    .map((id) => ({ id, label: memberNameById.get(id) ?? "Team member" }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const vendorOptions: MultiSelectOption[] = [
    ...new Set((invoices ?? []).map((i) => i.vendor_name).filter((v): v is string => !!v)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ id: v, label: v }));

  const projectOptions: MultiSelectOption[] = (projects ?? []).map((p) => ({
    id: p.id,
    label: p.name,
  }));

  const classOptions: MultiSelectOption[] = [
    ...new Set((lineItemRows ?? []).map((r) => r.class).filter((c): c is string => !!c)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ id: c, label: c }));

  // Class lives on line items, not the invoice itself — an invoice matches
  // a Class filter if ANY of its line items carry that class.
  const classesByInvoice = new Map<string, Set<string>>();
  const lineItemsByInvoiceForMatching = new Map<
    string,
    { class: string | null; category: string | null; project_id: string | null }[]
  >();
  for (const row of lineItemRows ?? []) {
    const list = lineItemsByInvoiceForMatching.get(row.invoice_id) ?? [];
    list.push({ class: row.class, category: row.category, project_id: row.project_id });
    lineItemsByInvoiceForMatching.set(row.invoice_id, list);
    if (!row.class) continue;
    const set = classesByInvoice.get(row.invoice_id) ?? new Set<string>();
    set.add(row.class);
    classesByInvoice.set(row.invoice_id, set);
  }

  const approvedByInvoice = new Map<string, Set<string>>();
  for (const row of approvedRows ?? []) {
    if (!row.approver_id) continue;
    const set = approvedByInvoice.get(row.invoice_id) ?? new Set<string>();
    set.add(row.approver_id);
    approvedByInvoice.set(row.invoice_id, set);
  }

  // Per-step conditional routing: which approvers are actually "in play"
  // for a given step depends on the specific invoice (its supplier/class/
  // customer) — see workflow-conditions.ts for the matching rules this
  // mirrors from is_eligible_approver() (migration 0027).
  const stepApproversByStepId = new Map<string, StepApprover[]>();
  for (const a of allStepApprovers ?? []) {
    const list = stepApproversByStepId.get(a.step_id) ?? [];
    list.push({ id: a.id, approver_user_id: a.approver_user_id, is_default: a.is_default });
    stepApproversByStepId.set(a.step_id, list);
  }
  const conditionsByStepApproverId = new Map<string, StepCondition[]>();
  for (const c of allStepConditions ?? []) {
    const list = conditionsByStepApproverId.get(c.step_approver_id) ?? [];
    list.push({
      step_approver_id: c.step_approver_id,
      field: c.field,
      operator: c.operator,
      match_values: c.match_values,
    });
    conditionsByStepApproverId.set(c.step_approver_id, list);
  }
  const stepByKey = new Map(
    (allSteps ?? []).map((s) => [`${s.workflow_id}:${s.step_order}`, s])
  );

  // Who currently has this document, if anyone — the field ApprovalMax's
  // own search screen doesn't offer (only "Requester" and "Approved by").
  // A step can have several conditionally-matched approvers now, so this
  // returns all of them (usually one, sometimes more when "all" mode
  // requires everyone to sign off, or the invoice's data happens to match
  // more than one approver's condition). An admin's reassignment
  // (step_override_approver_id) wins over the workflow's own routing,
  // but only for this one invoice — the workflow template is untouched.
  const holderOf = (invoice: Invoice): string[] => {
    if (
      invoice.workflow_id === null ||
      (invoice.status !== "on_approval" && invoice.status !== "on_hold")
    ) {
      return [];
    }
    if (invoice.step_override_approver_id) {
      return [invoice.step_override_approver_id];
    }
    const step = stepByKey.get(`${invoice.workflow_id}:${invoice.current_step_order}`);
    if (!step) return [];
    const approvers = stepApproversByStepId.get(step.id) ?? [];
    const conditions = approvers.flatMap(
      (a) => conditionsByStepApproverId.get(a.id) ?? []
    );
    return effectiveApproversForStep(
      approvers,
      conditions,
      { vendor_name: invoice.vendor_name, project_id: invoice.project_id },
      lineItemsByInvoiceForMatching.get(invoice.id) ?? []
    );
  };

  const requiresMyApproval = (invoice: Invoice) =>
    invoice.status === "on_approval" &&
    invoice.workflow_id !== null &&
    holderOf(invoice).includes(user.id);

  const counts = {
    all: invoices?.length ?? 0,
    review: invoices?.filter((i) => i.status === "on_review").length ?? 0,
    mine: invoices?.filter(requiresMyApproval).length ?? 0,
    created: invoices?.filter((i) => i.submitted_by === user.id).length ?? 0,
    approved: invoices?.filter((i) => i.status === "approved").length ?? 0,
    rejected: invoices?.filter((i) => i.status === "rejected").length ?? 0,
  };

  let filtered = invoices ?? [];
  if (view === "review") filtered = filtered.filter((i) => i.status === "on_review");
  else if (view === "mine") filtered = filtered.filter(requiresMyApproval);
  else if (view === "created") filtered = filtered.filter((i) => i.submitted_by === user.id);
  else if (view === "approved") filtered = filtered.filter((i) => i.status === "approved");
  else if (view === "rejected") filtered = filtered.filter((i) => i.status === "rejected");

  if (q) {
    filtered = filtered.filter((i) =>
      [i.vendor_name, i.file_name, i.invoice_number].some((f) =>
        f?.toLowerCase().includes(q)
      )
    );
  }

  // Advanced "Document search" filters — each multi-select field matches
  // ANY of its selected values (vendor A OR vendor B); different fields
  // combine with AND, layered on top of the sidebar view + quick search.
  const advanced: DocumentSearchFilters = {
    status: csvParam(searchParams.status),
    holder: csvParam(searchParams.holder),
    requester: csvParam(searchParams.requester),
    approvedBy: csvParam(searchParams.approvedBy),
    supplier: csvParam(searchParams.supplier),
    customer: csvParam(searchParams.customer),
    class: csvParam(searchParams.class),
    number: searchParams.number ?? "",
    dateFrom: searchParams.dateFrom ?? "",
    dateTo: searchParams.dateTo ?? "",
    amountFrom: searchParams.amountFrom ?? "",
    amountTo: searchParams.amountTo ?? "",
  };
  const activeFilterCount =
    [
      advanced.status,
      advanced.holder,
      advanced.requester,
      advanced.approvedBy,
      advanced.supplier,
      advanced.customer,
      advanced.class,
    ].filter((a) => a.length > 0).length +
    [advanced.number, advanced.dateFrom, advanced.dateTo, advanced.amountFrom, advanced.amountTo]
      .filter(Boolean).length;

  if (advanced.status.length > 0) {
    filtered = filtered.filter((i) => advanced.status.includes(i.status));
  }
  if (advanced.holder.length > 0) {
    filtered = filtered.filter((i) =>
      holderOf(i).some((id) => advanced.holder.includes(id))
    );
  }
  if (advanced.requester.length > 0) {
    filtered = filtered.filter(
      (i) => i.submitted_by !== null && advanced.requester.includes(i.submitted_by)
    );
  }
  if (advanced.approvedBy.length > 0) {
    filtered = filtered.filter((i) => {
      const approvers = approvedByInvoice.get(i.id);
      return approvers != null && advanced.approvedBy.some((a) => approvers.has(a));
    });
  }
  if (advanced.supplier.length > 0) {
    filtered = filtered.filter(
      (i) => i.vendor_name !== null && advanced.supplier.includes(i.vendor_name)
    );
  }
  if (advanced.customer.length > 0) {
    filtered = filtered.filter(
      (i) => i.project_id !== null && advanced.customer.includes(i.project_id)
    );
  }
  if (advanced.class.length > 0) {
    filtered = filtered.filter((i) => {
      const invoiceClasses = classesByInvoice.get(i.id);
      return invoiceClasses != null && advanced.class.some((c) => invoiceClasses.has(c));
    });
  }
  if (advanced.number.trim()) {
    const needle = advanced.number.trim().toLowerCase();
    filtered = filtered.filter((i) => i.invoice_number?.toLowerCase().includes(needle));
  }
  if (advanced.dateFrom) {
    filtered = filtered.filter((i) => i.bill_date !== null && i.bill_date >= advanced.dateFrom);
  }
  if (advanced.dateTo) {
    filtered = filtered.filter((i) => i.bill_date !== null && i.bill_date <= advanced.dateTo);
  }
  if (advanced.amountFrom) {
    const min = Number(advanced.amountFrom);
    filtered = filtered.filter((i) => i.amount !== null && i.amount >= min);
  }
  if (advanced.amountTo) {
    const max = Number(advanced.amountTo);
    filtered = filtered.filter((i) => i.amount !== null && i.amount <= max);
  }

  const selected = selectedId ? filtered.find((i) => i.id === selectedId) : filtered[0];
  if (selectedId && !selected) notFound();

  // List display only: pin duplicate pairs/groups together at the very
  // top, newest group first — grouped by their duplicate key (not just
  // individually bubbled up), so a resubmission surfaces right next to
  // the invoice it duplicates instead of getting lost further down.
  // `filtered` (created_at DESC) stays the source of truth for default
  // selection and every other computation — this only reshapes the list
  // pane's render order.
  const pinnedGroupsMap = new Map<string, Invoice[]>();
  const unpinnedInDisplayOrder: Invoice[] = [];
  for (const inv of filtered) {
    if (!duplicateInvoiceIds.has(inv.id)) {
      unpinnedInDisplayOrder.push(inv);
      continue;
    }
    const key = duplicateGroupKey(inv)!;
    if (!pinnedGroupsMap.has(key)) pinnedGroupsMap.set(key, []);
    pinnedGroupsMap.get(key)!.push(inv);
  }
  // `filtered` is already created_at DESC, so within each group (and
  // across groups, by each group's first/newest member) that order is
  // preserved — no extra sort needed.
  const pinnedDuplicates = [...pinnedGroupsMap.values()].flat();
  const filteredForDisplay = [...pinnedDuplicates, ...unpinnedInDisplayOrder];

  // Possible duplicate: same supplier + invoice number already exists and
  // isn't cancelled/rejected. Computed live (not stored) so it never goes
  // stale if invoice_number/vendor_name get edited later in the Bill panel.
  // Amount differing is flagged as a likely price-corrected resubmission,
  // not treated as a stronger/weaker signal — a human still decides either
  // way.
  const possibleDuplicates: Invoice[] =
    selected?.invoice_number && selected?.vendor_name
      ? (invoices ?? []).filter(
          (i) =>
            i.id !== selected.id &&
            i.status !== "cancelled" &&
            i.status !== "rejected" &&
            i.invoice_number === selected.invoice_number &&
            i.vendor_name?.trim().toLowerCase() ===
              selected.vendor_name!.trim().toLowerCase()
        )
      : [];

  const detailQuery = new URLSearchParams();
  if (view !== "all") detailQuery.set("view", view);
  if (q) detailQuery.set("q", q);
  if (advanced.status.length) detailQuery.set("status", advanced.status.join(","));
  if (advanced.holder.length) detailQuery.set("holder", advanced.holder.join(","));
  if (advanced.requester.length) detailQuery.set("requester", advanced.requester.join(","));
  if (advanced.approvedBy.length) detailQuery.set("approvedBy", advanced.approvedBy.join(","));
  if (advanced.supplier.length) detailQuery.set("supplier", advanced.supplier.join(","));
  if (advanced.customer.length) detailQuery.set("customer", advanced.customer.join(","));
  if (advanced.class.length) detailQuery.set("class", advanced.class.join(","));
  if (advanced.number) detailQuery.set("number", advanced.number);
  if (advanced.dateFrom) detailQuery.set("dateFrom", advanced.dateFrom);
  if (advanced.dateTo) detailQuery.set("dateTo", advanced.dateTo);
  if (advanced.amountFrom) detailQuery.set("amountFrom", advanced.amountFrom);
  if (advanced.amountTo) detailQuery.set("amountTo", advanced.amountTo);
  const qs = detailQuery.toString() ? `?${detailQuery.toString()}` : "";

  let signedFileUrl: string | null = null;
  let stepsForSelected: NonNullable<typeof allSteps> = [];
  let approvalsForSelected: Database["public"]["Tables"]["invoice_approvals"]["Row"][] = [];
  let commentsForSelected: Database["public"]["Tables"]["invoice_comments"]["Row"][] = [];
  let documentsForSelected: DocumentRef[] = [];
  let lineItemsForSelected: Database["public"]["Tables"]["invoice_line_items"]["Row"][] = [];
  let auditEntriesForSelected: Database["public"]["Tables"]["audit_log"]["Row"][] = [];
  let authorNameById = new Map<string, string>();
  let supplierDefaultsForSelected: SupplierDefaultsValues = {
    category: "",
    class: "",
    project_id: "",
    tax_rate: "",
    payment_terms_days: "",
    currency: "",
  };

  if (selected) {
    const [signed, approvalsRes, commentsRes, docsRes, lineItemsRes, auditRes] =
      await Promise.all([
        supabase.storage.from("invoices").createSignedUrl(selected.file_path, 60 * 10),
        supabase.from("invoice_approvals").select("*").eq("invoice_id", selected.id),
        supabase
          .from("invoice_comments")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("invoice_documents")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("invoice_line_items")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("line_order", { ascending: true }),
        supabase
          .from("audit_log")
          .select("*")
          .eq("invoice_id", selected.id)
          .order("created_at", { ascending: true }),
      ]);
    signedFileUrl = signed.data?.signedUrl ?? null;
    approvalsForSelected = approvalsRes.data ?? [];
    commentsForSelected = commentsRes.data ?? [];
    lineItemsForSelected = lineItemsRes.data ?? [];
    auditEntriesForSelected = auditRes.data ?? [];
    stepsForSelected = (allSteps ?? []).filter((s) => s.workflow_id === selected.workflow_id);

    if (selected.vendor_name) {
      const { data: sd } = await supabase
        .from("supplier_defaults")
        .select("*")
        .eq("organization_id", org.id)
        .eq("vendor_name_normalized", selected.vendor_name.trim().toLowerCase())
        .maybeSingle();
      if (sd) {
        supplierDefaultsForSelected = {
          category: sd.category ?? "",
          class: sd.class ?? "",
          project_id: sd.project_id ?? "",
          tax_rate: sd.tax_rate?.toString() ?? "",
          payment_terms_days: sd.payment_terms_days?.toString() ?? "",
          currency: sd.currency ?? "",
        };
      } else {
        // No saved rule yet — prefill from what's already on this invoice
        // (its first line item + currency/dates) instead of a blank form,
        // so confirming a new rule is a one-click "yes, remember this"
        // rather than retyping everything a second time.
        const firstLine = lineItemsForSelected[0];
        const termsDays =
          selected.bill_date && selected.due_date
            ? Math.round(
                (new Date(`${selected.due_date}T00:00:00Z`).getTime() -
                  new Date(`${selected.bill_date}T00:00:00Z`).getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            : null;
        supplierDefaultsForSelected = {
          category: firstLine?.category ?? "",
          class: firstLine?.class ?? "",
          project_id: firstLine?.project_id ?? "",
          tax_rate: firstLine?.tax_rate?.toString() ?? "",
          payment_terms_days: termsDays != null && termsDays >= 0 ? termsDays.toString() : "",
          currency: selected.currency ?? "",
        };
      }
    }

    // Document list for the viewer: the primary file first, then any
    // additional pages (multi-document support, migration 0003).
    const attachmentRows = docsRes.data ?? [];
    const attachmentUrls = await Promise.all(
      attachmentRows.map(async (d) => {
        const { data } = await supabase.storage
          .from("invoices")
          .createSignedUrl(d.file_path, 60 * 10);
        return data?.signedUrl ?? null;
      })
    );
    documentsForSelected = [
      ...(signedFileUrl
        ? [
            {
              name: selected.file_name,
              url: signedFileUrl,
              isPdf: isPdfName(selected.file_name),
              isImage: isImageName(selected.file_name),
            },
          ]
        : []),
      ...attachmentRows.map((d, i) => ({
        name: d.file_name,
        url: attachmentUrls[i] ?? null,
        isPdf: isPdfName(d.file_name),
        isImage: isImageName(d.file_name),
      })),
    ];

    // Resolve comment/audit-actor names (profiles RLS lets org members read
    // each other since migration 0002).
    const authorIds = [
      ...new Set(
        [
          ...commentsForSelected.map((c) => c.author_id),
          ...auditEntriesForSelected.map((a) => a.actor_id),
        ].filter((id): id is string => !!id)
      ),
    ];
    const { data: authors } =
      authorIds.length > 0
        ? await supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", authorIds)
        : { data: [] };
    authorNameById = new Map(
      (authors ?? []).map((a) => [a.id, a.full_name ?? "Team member"])
    );
  }

  const auditTimelineForSelected = buildAuditTimeline({
    auditEntries: auditEntriesForSelected,
    comments: commentsForSelected,
    nameOf: (id) => (id ? authorNameById.get(id) ?? "Team member" : "System"),
  });

  const currentStepApprovers = selected ? holderOf(selected) : [];
  // Only an approver actually required for the current step sees the
  // buttons; the server action enforces the same rule regardless of what
  // the UI shows.
  const canDecide =
    selected != null &&
    selected.status === "on_approval" &&
    selected.workflow_id !== null &&
    currentStepApprovers.includes(user.id);

  // Per step_order, has that step's required approver(s) resolved it yet
  // — for the ApprovalStepper display. Mirrors holderOf's own logic per
  // step rather than just the current one.
  const stepStatesForSelected = new Map<number, "pending" | "approved" | "rejected">();
  if (selected) {
    const decisionsByStep = new Map<
      number,
      { approver_id: string | null; decision: string }[]
    >();
    for (const a of approvalsForSelected) {
      const list = decisionsByStep.get(a.step_order) ?? [];
      list.push({ approver_id: a.approver_id, decision: a.decision });
      decisionsByStep.set(a.step_order, list);
    }
    for (const step of stepsForSelected) {
      const approvers = stepApproversByStepId.get(step.id) ?? [];
      const conditions = approvers.flatMap(
        (a) => conditionsByStepApproverId.get(a.id) ?? []
      );
      const required =
        selected.step_override_approver_id && step.step_order === selected.current_step_order
          ? [selected.step_override_approver_id]
          : effectiveApproversForStep(
              approvers,
              conditions,
              { vendor_name: selected.vendor_name, project_id: selected.project_id },
              lineItemsForSelected.map((li) => ({
                class: li.class,
                category: li.category,
                project_id: li.project_id,
              }))
            );
      stepStatesForSelected.set(
        step.step_order,
        stepDecisionState(
          step.approval_mode,
          required,
          decisionsByStep.get(step.step_order) ?? []
        )
      );
    }
  }

  // The submitter can withdraw their own not-yet-decided invoice; an admin
  // can cancel anyone's.
  const canCancel =
    selected != null &&
    (selected.status === "on_review" ||
      selected.status === "on_approval" ||
      selected.status === "on_hold") &&
    (selected.submitted_by === user.id || canReviewNow);

  const navItems: { key: View; label: string }[] = [
    { key: "all", label: "All invoices" },
    ...(canSeeReviewQueue
      ? [{ key: "review" as View, label: "Pending Review" }]
      : []),
    { key: "mine", label: "Requires my approval" },
    { key: "created", label: "Created by me" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      {/* Sidebar (collapsible via hamburger) */}
      <Sidebar>
        <div className="border-b border-slate-200 p-4">
          <div className="text-sm font-semibold">{org.name}</div>
          <div className="mt-0.5 truncate text-xs text-slate-400" title={`${org.inbound_email_token}@${process.env.INBOUND_EMAIL_DOMAIN}`}>
            {org.inbound_email_token}@{process.env.INBOUND_EMAIL_DOMAIN}
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {navItems.map((item) => (
            <Link
              key={item.key}
              href={`/dashboard${item.key === "all" ? "" : `?view=${item.key}`}`}
              className={clsx(
                "flex items-center justify-between rounded-md px-3 py-2 text-sm",
                view === item.key
                  ? "bg-blue-50 font-medium text-blue-700"
                  : "text-slate-600 hover:bg-slate-100"
              )}
            >
              {item.label}
              <span
                className={clsx(
                  "rounded-full px-1.5 py-0.5 text-xs",
                  view === item.key ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500"
                )}
              >
                {counts[item.key]}
              </span>
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-2">
          {unreadNotificationsCount > 0 && (
            <Link
              href="/notifications"
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-blue-700 hover:bg-blue-50"
            >
              <span className="flex items-center gap-2">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                Mentions
              </span>
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                {unreadNotificationsCount}
              </span>
            </Link>
          )}
          {pendingSplitsCount > 0 && (
            <Link
              href="/invoices/pending-splits"
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-orange-700 hover:bg-orange-50"
            >
              <span className="flex items-center gap-2">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6M9 15l2 2 4-4" />
                </svg>
                Needs split review
              </span>
              <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700">
                {pendingSplitsCount}
              </span>
            </Link>
          )}
          <Link
            href="/workflows"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
            </svg>
            Workflows
          </Link>
          <Link
            href="/reports"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 3 3 5-6" />
            </svg>
            Reports
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </Link>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 p-4">
          <span className="truncate text-xs text-slate-500">{user.email}</span>
          <SignOutButton />
        </div>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex flex-none items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="w-80">
            <SearchInput defaultValue={q} />
          </div>
          <DocumentSearchModal
            statuses={STATUS_OPTIONS}
            members={memberOptions}
            vendors={vendorOptions}
            projects={projectOptions}
            classes={classOptions}
            initial={advanced}
            activeCount={activeFilterCount}
          />
          <div className="flex-1" />
          {!isAuditor && (
            <Link
              href="/invoices/new"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              + Add invoice
            </Link>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          {/* List pane (collapsible) */}
          <CollapsiblePane title="Invoices">
            {filteredForDisplay.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No invoices in this view.
              </div>
            ) : (
              filteredForDisplay.map((invoice, i) => (
                <div key={invoice.id}>
                  {i === 0 && pinnedDuplicates.length > 0 && (
                    <div className="flex items-center gap-1.5 border-b border-orange-200 bg-orange-50 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path
                          d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Possible duplicates
                    </div>
                  )}
                  {i === pinnedDuplicates.length && pinnedDuplicates.length > 0 && (
                    <div className="border-b border-slate-200 bg-slate-50 px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      All invoices
                    </div>
                  )}
                  <Link
                    href={`/dashboard/${invoice.id}${qs}`}
                    className={clsx(
                      "block border-b border-slate-100 px-4 py-3",
                      duplicateInvoiceIds.has(invoice.id) && "border-l-2 border-l-orange-300",
                      selected?.id === invoice.id ? "bg-blue-50" : "hover:bg-slate-50"
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <div className="min-w-0 flex-1 truncate text-sm font-medium">
                        {invoice.vendor_name ?? invoice.file_name}
                      </div>
                      {duplicateInvoiceIds.has(invoice.id) && (
                        <span className="inline-flex flex-none items-center rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-800">
                          Duplicate
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-xs text-slate-500">
                        {invoice.amount != null
                          ? invoice.amount.toLocaleString(undefined, {
                              style: "currency",
                              currency: invoice.currency,
                            })
                          : "No amount extracted"}
                      </span>
                      <InvoiceStatusBadge status={invoice.status} />
                    </div>
                    {(() => {
                      const holderIds = holderOf(invoice);
                      return holderIds.length > 0 ? (
                        <div className="mt-1 text-xs text-slate-400">
                          With{" "}
                          {holderIds
                            .map((id) => memberNameById.get(id) ?? "Team member")
                            .join(", ")}
                        </div>
                      ) : null;
                    })()}
                  </Link>
                </div>
              ))
            )}
          </CollapsiblePane>

          {/* Detail pane: document viewer + bill panel + side panel */}
          <div className="flex min-w-0 flex-1">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                Select an invoice to view details.
              </div>
            ) : (
              <DetailSplit
                documents={documentsForSelected}
                uploadAction={addDocument.bind(null, selected.id)}
                canEdit={canEdit}
                bill={{
                  invoice: selected,
                  primaryFileUrl: signedFileUrl,
                  documentCount: documentsForSelected.length,
                  lineItems: lineItemsForSelected,
                  projects: (projects ?? []).map((p) => ({
                    id: p.id,
                    name: p.name,
                  })),
                  saveBill: saveBill.bind(null, selected.id),
                  saveLineItem: saveLineItem.bind(null, selected.id),
                  deleteLineItem: deleteLineItem.bind(null, selected.id),
                  reExtract: reExtract.bind(null, selected.id),
                  backToReview: backToReview.bind(null, selected.id),
                  canReview: canReviewNow,
                  readOnly: !canEdit,
                  supplierDefaults: supplierDefaultsForSelected,
                  saveSupplierDefaults: saveSupplierDefaults.bind(
                    null,
                    selected.id,
                    selected.vendor_name ?? selected.file_name
                  ),
                  auditTimeline: auditTimelineForSelected,
                  comments: commentsForSelected,
                  authorNameById,
                  addComment: addComment.bind(null, selected.id),
                  members: memberOptions,
                  approval: {
                    currentStepApproverNames: currentStepApprovers.map(
                      (id) => memberNameById.get(id) ?? "Team member"
                    ),
                    steps: stepsForSelected,
                    stepStates: stepStatesForSelected,
                    canDecide,
                    canCancel,
                    reviewComplete: reviewComplete.bind(null, selected.id),
                    hold: holdInvoice.bind(null, selected.id),
                    reject: decide.bind(null, selected.id, "rejected"),
                    cancel: cancelInvoice.bind(null, selected.id),
                  },
                  admin: {
                    visible: canReviewNow,
                    showReassign:
                      selected.status === "on_approval" ||
                      selected.status === "on_hold",
                    reassignDefaultValue: selected.step_override_approver_id ?? "",
                    memberOptions,
                    reassign: reassignApprover.bind(null, selected.id),
                    statusOptions: STATUS_OPTIONS.map((s) => ({
                      value: s.id,
                      label: s.label,
                    })),
                    overrideStatus: overrideStatus.bind(null, selected.id),
                    deleteInvoice: deleteInvoiceAction.bind(null, selected.id),
                  },
                  instructions: {
                    initialValue: selected.accounting_instructions ?? "",
                    readOnly: isAuditor,
                    saveInstructions: saveAccountingInstructions.bind(
                      null,
                      selected.id
                    ),
                    approve: canDecide
                      ? decide.bind(null, selected.id, "approved")
                      : undefined,
                  },
                  alerts: (
                    <>
                      {searchParams.error && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                          {DECISION_ERRORS[searchParams.error] ??
                            "That action could not be completed."}
                        </div>
                      )}

                      {possibleDuplicates.length > 0 && (
                        <div className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
                          <p className="font-medium">
                            Possible duplicate — invoice #{selected!.invoice_number} from{" "}
                            {selected!.vendor_name} already exists.
                          </p>
                          <ul className="mt-1.5 space-y-1">
                            {possibleDuplicates.map((d) => (
                              <li key={d.id}>
                                <Link
                                  href={`/dashboard/${d.id}${qs}`}
                                  className="underline hover:no-underline"
                                >
                                  {new Date(d.created_at).toLocaleDateString()} —{" "}
                                  {d.amount != null
                                    ? d.amount.toLocaleString(undefined, {
                                        style: "currency",
                                        currency: d.currency,
                                      })
                                    : "no amount"}
                                </Link>
                                {d.amount !== selected!.amount && (
                                  <span className="ml-1 text-xs text-orange-700">
                                    (amount differs from this one — possible price-corrected
                                    resubmission, not necessarily a true duplicate)
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
