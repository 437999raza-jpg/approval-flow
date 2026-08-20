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
import type { Database } from "@/lib/supabase/types";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];

const VIEWS = ["all", "mine", "created", "approved", "rejected"] as const;
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
      </main>
    );
  }

  const selectedId = params.id?.[0];
  const view: View = VIEWS.includes(searchParams.view as View)
    ? (searchParams.view as View)
    : "all";
  const q = searchParams.q?.trim().toLowerCase() ?? "";

  const [{ data: invoices }, { data: workflows }] = await Promise.all([
    supabase
      .from("invoices")
      .select("*")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false }),
    supabase.from("approval_workflows").select("id").eq("organization_id", org.id),
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
    mine: invoices?.filter(requiresMyApproval).length ?? 0,
    created: invoices?.filter((i) => i.submitted_by === user.id).length ?? 0,
    approved: invoices?.filter((i) => i.status === "approved").length ?? 0,
    rejected: invoices?.filter((i) => i.status === "rejected").length ?? 0,
  };

  let filtered = invoices ?? [];
  if (view === "mine") filtered = filtered.filter(requiresMyApproval);
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
  let authorNameById = new Map<string, string>();

  if (selected) {
    const [signed, approvalsRes, commentsRes] = await Promise.all([
      supabase.storage.from("invoices").createSignedUrl(selected.file_path, 60 * 10),
      supabase.from("invoice_approvals").select("*").eq("invoice_id", selected.id),
      supabase
        .from("invoice_comments")
        .select("*")
        .eq("invoice_id", selected.id)
        .order("created_at", { ascending: true }),
    ]);
    signedFileUrl = signed.data?.signedUrl ?? null;
    approvalsForSelected = approvalsRes.data ?? [];
    commentsForSelected = commentsRes.data ?? [];
    stepsForSelected = (allSteps ?? []).filter((s) => s.workflow_id === selected.workflow_id);

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

  // Decide how to preview the attached document (allowed types are pdf,
  // png, jpeg, webp — see src/lib/invoices.ts).
  const fileNameExt =
    selected?.file_name.split(".").pop()?.toLowerCase() ?? "";
  const isPdf = fileNameExt === "pdf";
  const isImage = ["png", "jpg", "jpeg", "webp"].includes(fileNameExt);

  const navItems: { key: View; label: string }[] = [
    { key: "all", label: "All invoices" },
    { key: "mine", label: "Requires my approval" },
    { key: "created", label: "Created by me" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      {/* Sidebar */}
      <aside className="flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
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
        <div className="flex items-center justify-between border-t border-slate-200 p-4">
          <span className="truncate text-xs text-slate-500">{user.email}</span>
          <SignOutButton />
        </div>
      </aside>

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
          {/* List pane */}
          <div className="w-96 flex-none overflow-y-auto border-r border-slate-200">
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
          </div>

          {/* Detail pane: document viewer + side panel (Dext/ApprovalMax-style split) */}
          <div className="flex min-w-0 flex-1">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                Select an invoice to view details.
              </div>
            ) : (
              <>
                {/* Left: the invoice document */}
                <div className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-slate-100">
                  <div className="flex flex-none items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
                    <span className="truncate text-sm font-medium text-slate-700">
                      {selected.file_name}
                    </span>
                    {signedFileUrl && (
                      <a
                        href={signedFileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-none text-xs font-medium text-blue-600 hover:underline"
                      >
                        Open in new tab ↗
                      </a>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-4">
                    {signedFileUrl ? (
                      isImage ? (
                        <img
                          src={signedFileUrl}
                          alt={selected.file_name}
                          className="mx-auto max-w-full rounded-md shadow"
                        />
                      ) : isPdf ? (
                        <object
                          data={signedFileUrl}
                          type="application/pdf"
                          className="h-full w-full"
                        >
                          <p className="text-sm text-slate-500">
                            Your browser can&apos;t display this PDF.{" "}
                            <a
                              href={signedFileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-600 underline"
                            >
                              Open it instead
                            </a>
                            .
                          </p>
                        </object>
                      ) : (
                        <p className="text-sm text-slate-500">
                          No preview for this file type.{" "}
                          <a
                            href={signedFileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 underline"
                          >
                            Open file
                          </a>
                          .
                        </p>
                      )
                    ) : (
                      <p className="text-sm text-slate-500">
                        File preview unavailable.
                      </p>
                    )}
                  </div>
                </div>

                {/* Right: data + approvals + discussion */}
                <div className="w-[400px] flex-none overflow-y-auto">
                  <div className="p-6">
                {searchParams.error && (
                  <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {DECISION_ERRORS[searchParams.error] ??
                      "That action could not be completed."}
                  </div>
                )}
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-xl font-semibold">
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

                {stepsForSelected.length > 0 && (
                  <div className="mt-6 rounded-lg border border-slate-200 p-4">
                    <ApprovalStepper
                      steps={stepsForSelected}
                      approvals={approvalsForSelected}
                      currentStepOrder={selected.current_step_order}
                      invoiceStatus={selected.status}
                    />
                  </div>
                )}

                {selected.status !== "approved" && selected.status !== "rejected" && (
                  <div className="mt-6 flex gap-3">
                    {canDecide ? (
                      <>
                        <form action={decide.bind(null, selected.id, "approved")}>
                          <button className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                            Approve
                          </button>
                        </form>
                        <form action={decide.bind(null, selected.id, "rejected")}>
                          <button className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
                            Reject
                          </button>
                        </form>
                      </>
                    ) : (
                      <p className="text-sm text-slate-500">
                        Waiting on the approver for step{" "}
                        {selected.current_step_order}.
                      </p>
                    )}
                  </div>
                )}

                {/* Discussion — the chat foundation. Real-time updates via
                    Supabase Realtime can layer on top of invoice_comments. */}
                <div className="mt-6 rounded-lg border border-slate-200 p-4">
                  <h2 className="text-sm font-semibold text-slate-700">
                    Discussion
                  </h2>
                  <div className="mt-3 space-y-3">
                    {commentsForSelected.length === 0 ? (
                      <p className="text-sm text-slate-400">
                        No comments yet. Chat with your team about this invoice
                        here.
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
                </div>

                <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-slate-200 pt-6 text-sm">
                  {selected.due_date && (
                    <>
                      <dt className="text-slate-500">Due date</dt>
                      <dd>{new Date(selected.due_date).toLocaleDateString()}</dd>
                    </>
                  )}
                  <dt className="text-slate-500">Source</dt>
                  <dd className="capitalize">
                    {selected.source}
                    {selected.source_email ? ` (${selected.source_email})` : ""}
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
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
