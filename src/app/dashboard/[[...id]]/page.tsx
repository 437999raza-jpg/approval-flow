// Master-detail dashboard: list + detail panes, approve/reject with
// per-step approver authorization, invoice discussion (chat foundation),
// and the audit-trail document download. Authored by Araza.
import Link from "next/link";
import { clsx } from "clsx";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { ApprovalStepper } from "@/components/ApprovalStepper";
import { SearchInput } from "@/components/SearchInput";
import { SignOutButton } from "@/components/SignOutButton";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { InstructionsBox } from "@/components/InstructionsBox";
import { CollapsiblePane } from "@/components/CollapsiblePane";
import { DetailSplit, type DocumentRef } from "@/components/DetailSplit";
import { Sidebar } from "@/components/Sidebar";
import type { Database } from "@/lib/supabase/types";
import {
  extractInvoiceFields,
  mapExtractionToInvoice,
} from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];

const VIEWS = ["all", "review", "mine", "created", "approved", "rejected"] as const;
type View = (typeof VIEWS)[number];

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
async function decide(invoiceId: string, decision: "approved" | "rejected") {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();
  if (!invoice || !invoice.workflow_id) {
    redirect(`/dashboard/${invoiceId}?error=not-your-step`);
  }

  if (invoice.status !== "pending" && invoice.status !== "in_review") {
    redirect(`/dashboard/${invoiceId}?error=already-decided`);
  }

  const { data: steps } = await supabase
    .from("approval_workflow_steps")
    .select("step_order, approver_user_id")
    .eq("workflow_id", invoice.workflow_id)
    .order("step_order", { ascending: true });
  const orderedSteps = steps ?? [];

  const currentStep = orderedSteps.find(
    (s) => s.step_order === invoice.current_step_order
  );
  if (!currentStep || currentStep.approver_user_id !== user.id) {
    redirect(`/dashboard/${invoiceId}?error=not-your-step`);
  }

  const { data: approvals } = await supabase
    .from("invoice_approvals")
    .select("step_order, decision")
    .eq("invoice_id", invoiceId);

  const priorSteps = orderedSteps.filter(
    (s) => s.step_order < invoice.current_step_order
  );
  const approvedPrior =
    (approvals ?? []).filter(
      (a) => a.step_order < invoice.current_step_order && a.decision === "approved"
    ).length;
  if (approvedPrior < priorSteps.length) {
    redirect(`/dashboard/${invoiceId}?error=step-required`);
  }

  const alreadyDecided = (approvals ?? []).some(
    (a) => a.step_order === invoice.current_step_order
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

  const lastStep = orderedSteps[orderedSteps.length - 1]?.step_order ?? 1;
  const isFinalStep = invoice.current_step_order >= lastStep;

  const nextStatus =
    decision === "rejected" ? "rejected" : isFinalStep ? "approved" : "in_review";

  await supabase
    .from("invoices")
    .update({
      status: nextStatus,
      current_step_order:
        decision === "approved" && !isFinalStep
          ? invoice.current_step_order + 1
          : invoice.current_step_order,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

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
async function addComment(invoiceId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  await supabase.from("invoice_comments").insert({
    invoice_id: invoiceId,
    author_id: user.id,
    body,
  });

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

  await supabase
    .from("invoices")
    .update({
      accounting_instructions: instructions || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  revalidatePath("/dashboard", "layout");
}

// Parse the Bill panel form into an invoices update object.
function parseBillForm(formData: FormData): Record<string, unknown> {
  const text = (key: string) =>
    String(formData.get(key) ?? "").trim() || null;
  const num = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
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
    amount: num("amount"),
    currency: text("currency")?.toUpperCase() || "USD",
    tax_amount: num("tax_amount"),
    project_id: text("project_id"),
  };
}

// Persist the editable bill fields (also fired by Enter in the form).
async function saveBill(invoiceId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase
    .from("invoices")
    .update({
      ...parseBillForm(formData),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  revalidatePath("/dashboard", "layout");
}

// Is the signed-in user allowed to review extracted data (admin or
// submitter)? Used by the review actions and to gate the Bill panel
// buttons.
async function canReview(supabase: ReturnType<typeof createClient>) {
  const org = await getCurrentOrg(supabase);
  return org ? org.role === "admin" || org.role === "submitter" : false;
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
  if (!inv || inv.status !== "pending_review") return;

  const [{ data: project }, { data: profile }, { data: lineItems }] =
    await Promise.all([
      inv.project_id
        ? supabase
            .from("projects")
            .select("name")
            .eq("id", inv.project_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      inv.submitted_by
        ? supabase
            .from("profiles")
            .select("full_name")
            .eq("id", inv.submitted_by)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("invoice_line_items")
        .select("category, description, class, amount")
        .eq("invoice_id", invoiceId),
    ]);

  const workflowId = await selectWorkflowForInvoice(
    supabase,
    inv.organization_id,
    {
      amount: inv.amount,
      vendorName: inv.vendor_name,
      submittedBy: inv.submitted_by,
      submitterName: profile?.full_name ?? null,
      projectId: inv.project_id,
      projectName: project?.name ?? null,
      lineItems: lineItems ?? [],
    }
  );

  await supabase
    .from("invoices")
    .update({
      workflow_id: workflowId,
      status: "pending",
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
    .select("id, organization_id, status, workflow_id, current_step_order")
    .eq("id", invoiceId)
    .single();
  if (!invoice || !invoice.workflow_id) return;
  if (invoice.status !== "pending" && invoice.status !== "in_review") return;

  const { data: currentStep } = await supabase
    .from("approval_workflow_steps")
    .select("approver_user_id")
    .eq("workflow_id", invoice.workflow_id)
    .eq("step_order", invoice.current_step_order)
    .maybeSingle();
  if (!currentStep || currentStep.approver_user_id !== user.id) return;

  await supabase
    .from("invoices")
    .update({ status: "held", updated_at: new Date().toISOString() })
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
      status: "pending_review",
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

  const text = (key: string) =>
    String(formData.get(key) ?? "").trim() || null;
  const num = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const values = {
    category: text("category"),
    description: text("description"),
    tax_rate: num("tax_rate"),
    class: text("class"),
    amount: num("amount"),
    linked: formData.get("linked") === "on",
  };

  if (lineItemId === "new") {
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

  revalidatePath("/dashboard", "layout");
}

async function deleteLineItem(lineItemId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("invoice_line_items").delete().eq("id", lineItemId);

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
  searchParams: { view?: string; q?: string; error?: string };
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
  const canReviewNow = org.role === "admin" || org.role === "submitter";
  const view: View = VIEWS.includes(searchParams.view as View)
    ? (searchParams.view as View)
    : "all";
  const q = searchParams.q?.trim().toLowerCase() ?? "";

  const [{ data: invoices }, { data: workflows }, { data: projects }] =
    await Promise.all([
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
    ]);

  const workflowIds = (workflows ?? []).map((w) => w.id);
  const { data: allSteps } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_steps")
          .select("*")
          .in("workflow_id", workflowIds)
          .order("step_order", { ascending: true })
      : { data: [] };

  const stepApproverByKey = new Map(
    (allSteps ?? []).map((s) => [`${s.workflow_id}:${s.step_order}`, s.approver_user_id])
  );

  const requiresMyApproval = (invoice: Invoice) =>
    (invoice.status === "pending" || invoice.status === "in_review") &&
    invoice.workflow_id !== null &&
    stepApproverByKey.get(`${invoice.workflow_id}:${invoice.current_step_order}`) === user.id;

  const counts = {
    all: invoices?.length ?? 0,
    review: invoices?.filter((i) => i.status === "pending_review").length ?? 0,
    mine: invoices?.filter(requiresMyApproval).length ?? 0,
    created: invoices?.filter((i) => i.submitted_by === user.id).length ?? 0,
    approved: invoices?.filter((i) => i.status === "approved").length ?? 0,
    rejected: invoices?.filter((i) => i.status === "rejected").length ?? 0,
  };

  let filtered = invoices ?? [];
  if (view === "review") filtered = filtered.filter((i) => i.status === "pending_review");
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

  const selected = selectedId ? filtered.find((i) => i.id === selectedId) : filtered[0];
  if (selectedId && !selected) notFound();

  const detailQuery = new URLSearchParams();
  if (view !== "all") detailQuery.set("view", view);
  if (q) detailQuery.set("q", q);
  const qs = detailQuery.toString() ? `?${detailQuery.toString()}` : "";

  let signedFileUrl: string | null = null;
  let stepsForSelected: NonNullable<typeof allSteps> = [];
  let approvalsForSelected: Database["public"]["Tables"]["invoice_approvals"]["Row"][] = [];
  let commentsForSelected: Database["public"]["Tables"]["invoice_comments"]["Row"][] = [];
  let documentsForSelected: DocumentRef[] = [];
  let lineItemsForSelected: Database["public"]["Tables"]["invoice_line_items"]["Row"][] = [];
  let authorNameById = new Map<string, string>();

  if (selected) {
    const [signed, approvalsRes, commentsRes, docsRes, lineItemsRes] =
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
      ]);
    signedFileUrl = signed.data?.signedUrl ?? null;
    approvalsForSelected = approvalsRes.data ?? [];
    commentsForSelected = commentsRes.data ?? [];
    lineItemsForSelected = lineItemsRes.data ?? [];
    stepsForSelected = (allSteps ?? []).filter((s) => s.workflow_id === selected.workflow_id);

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

    // Resolve comment author names (profiles RLS lets org members read each
    // other since migration 0002).
    const authorIds = [
      ...new Set(
        commentsForSelected
          .map((c) => c.author_id)
          .filter((id): id is string => !!id)
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

  const currentStepApprover =
    selected?.workflow_id != null
      ? stepApproverByKey.get(
          `${selected.workflow_id}:${selected.current_step_order}`
        )
      : undefined;
  // Only the approver assigned to the current step sees the buttons; the
  // server action enforces the same rule regardless of what the UI shows.
  const canDecide =
    selected != null &&
    (selected.status === "pending" || selected.status === "in_review") &&
    selected.workflow_id !== null &&
    currentStepApprover === user.id;

  const navItems: { key: View; label: string }[] = [
    { key: "all", label: "All invoices" },
    { key: "review", label: "Pending Review" },
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
          <div className="flex-1" />
          <Link
            href="/invoices/new"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            + Add invoice
          </Link>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* List pane (collapsible) */}
          <CollapsiblePane title="Invoices">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No invoices in this view.
              </div>
            ) : (
              filtered.map((invoice) => (
                <Link
                  key={invoice.id}
                  href={`/dashboard/${invoice.id}${qs}`}
                  className={clsx(
                    "block border-b border-slate-100 px-4 py-3",
                    selected?.id === invoice.id ? "bg-blue-50" : "hover:bg-slate-50"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate text-sm font-medium">
                      {invoice.vendor_name ?? invoice.file_name}
                    </span>
                    <InvoiceStatusBadge status={invoice.status} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {invoice.amount != null
                        ? invoice.amount.toLocaleString(undefined, {
                            style: "currency",
                            currency: invoice.currency,
                          })
                        : "No amount extracted"}
                    </span>
                    <span>{new Date(invoice.created_at).toLocaleDateString()}</span>
                  </div>
                </Link>
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
                  deleteLineItem,
                  reExtract: reExtract.bind(null, selected.id),
                  backToReview: backToReview.bind(null, selected.id),
                  canReview: canReviewNow,
                }}
              >
                {/* Side panel content: header + collapsible sections */}
                  <div className="border-b border-slate-200 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h1 className="truncate text-base font-semibold">
                          {selected.vendor_name ?? selected.file_name}
                        </h1>
                        {selected.invoice_number && (
                          <p className="text-sm text-slate-500">
                            Invoice #{selected.invoice_number}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        {selected.amount != null && (
                          <div className="text-lg font-semibold">
                            {selected.amount.toLocaleString(undefined, {
                              style: "currency",
                              currency: selected.currency,
                            })}
                          </div>
                        )}
                        <div className="mt-1">
                          <InvoiceStatusBadge status={selected.status} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {searchParams.error && (
                    <div className="mx-4 mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      {DECISION_ERRORS[searchParams.error] ??
                        "That action could not be completed."}
                    </div>
                  )}

                  <CollapsibleSection title="Status & approval">
                    {stepsForSelected.length > 0 && (
                      <div className="mt-3">
                        <ApprovalStepper
                          steps={stepsForSelected}
                          approvals={approvalsForSelected}
                          currentStepOrder={selected.current_step_order}
                          invoiceStatus={selected.status}
                        />
                      </div>
                    )}
                    {selected.status !== "approved" &&
                      selected.status !== "paid" && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {selected.status === "pending_review" &&
                          canReviewNow ? (
                            <form
                              action={reviewComplete.bind(null, selected.id)}
                            >
                              <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                                Review Complete
                              </button>
                            </form>
                          ) : null}
                          {selected.status === "pending_review" &&
                          !canReviewNow ? (
                            <p className="text-sm text-slate-500">
                              Awaiting review of the extracted data — an
                              admin or submitter must complete the review to
                              send it into the approval workflow.
                            </p>
                          ) : null}
                          {canDecide ? (
                            <>
                              <form
                                action={decide.bind(null, selected.id, "approved")}
                              >
                                <button className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                                  Approve
                                </button>
                              </form>
                              <form
                                action={holdInvoice.bind(null, selected.id)}
                              >
                                <button className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100">
                                  Hold
                                </button>
                              </form>
                              <form
                                action={decide.bind(null, selected.id, "rejected")}
                              >
                                <button className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
                                  Reject
                                </button>
                              </form>
                            </>
                          ) : null}
                          {selected.status === "held" && (
                            <p className="text-sm text-slate-500">
                              On hold — return it to review or approve/reject
                              once the decision is ready.
                            </p>
                          )}
                          {selected.status !== "pending_review" &&
                            selected.status !== "held" &&
                            !canDecide && (
                              <p className="text-sm text-slate-500">
                                Waiting on the approver for step{" "}
                                {selected.current_step_order}.
                              </p>
                            )}
                        </div>
                      )}
                  </CollapsibleSection>

                  <CollapsibleSection title="Extracted fields">
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                      <dt className="text-slate-500">Vendor</dt>
                      <dd>{selected.vendor_name ?? "—"}</dd>
                      <dt className="text-slate-500">Invoice #</dt>
                      <dd>{selected.invoice_number ?? "—"}</dd>
                      <dt className="text-slate-500">Amount</dt>
                      <dd>
                        {selected.amount != null
                          ? selected.amount.toLocaleString(undefined, {
                              style: "currency",
                              currency: selected.currency,
                            })
                          : "—"}
                      </dd>
                      <dt className="text-slate-500">Currency</dt>
                      <dd>{selected.currency}</dd>
                      {selected.due_date && (
                        <>
                          <dt className="text-slate-500">Due date</dt>
                          <dd>
                            {new Date(selected.due_date).toLocaleDateString()}
                          </dd>
                        </>
                      )}
                    </dl>
                  </CollapsibleSection>

                  <CollapsibleSection title="Instructions for accounting">
                    <InstructionsBox
                      initialValue={selected.accounting_instructions ?? ""}
                      saveInstructions={saveAccountingInstructions.bind(
                        null,
                        selected.id
                      )}
                    />
                  </CollapsibleSection>

                  <CollapsibleSection
                    title="Discussion"
                    badge={
                      commentsForSelected.length > 0
                        ? commentsForSelected.length
                        : undefined
                    }
                  >
                    <div className="mt-3 space-y-3">
                      {commentsForSelected.length === 0 ? (
                        <p className="text-sm text-slate-400">
                          No comments yet. Chat with your team about this
                          invoice here.
                        </p>
                      ) : (
                        commentsForSelected.map((comment) => (
                          <div
                            key={comment.id}
                            className="rounded-md bg-slate-50 px-3 py-2"
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-xs font-medium text-slate-700">
                                {comment.author_id
                                  ? (authorNameById.get(comment.author_id) ??
                                    "Team member")
                                  : "System"}
                              </span>
                              <span className="text-xs text-slate-400">
                                {new Date(comment.created_at).toLocaleString()}
                              </span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                              {comment.body}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                    <form
                      action={addComment.bind(null, selected.id)}
                      className="mt-3 flex gap-2"
                    >
                      <input
                        name="body"
                        required
                        placeholder="Ask a question or leave a note…"
                        className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                      />
                      <button className="rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
                        Post
                      </button>
                    </form>
                  </CollapsibleSection>

                  <CollapsibleSection title="Document details">
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                      <dt className="text-slate-500">Source</dt>
                      <dd className="capitalize">
                        {selected.source}
                        {selected.source_email
                          ? ` (${selected.source_email})`
                          : ""}
                      </dd>
                      <dt className="text-slate-500">File</dt>
                      <dd>
                        {signedFileUrl ? (
                          <a
                            href={signedFileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {selected.file_name}
                          </a>
                        ) : (
                          selected.file_name
                        )}
                      </dd>
                      <dt className="text-slate-500">Received</dt>
                      <dd>{new Date(selected.created_at).toLocaleString()}</dd>
                      <dt className="text-slate-500">Audit trail</dt>
                      <dd>
                        <a
                          href={`/api/invoices/${selected.id}/audit-trail`}
                          className="text-blue-600 hover:underline"
                        >
                          Download
                        </a>
                        <span className="ml-1 text-xs text-slate-400">
                          (approvals + chat)
                        </span>
                      </dd>
                    </dl>
                  </CollapsibleSection>
              </DetailSplit>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
