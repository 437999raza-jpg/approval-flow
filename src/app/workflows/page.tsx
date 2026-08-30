import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";
import { SignOutButton } from "@/components/SignOutButton";
import { WorkflowRuleRow } from "@/components/WorkflowRuleRow";
import { StepApproversManager } from "@/components/StepApproversManager";
import { CollapsibleWorkflowSection } from "@/components/CollapsibleWorkflowSection";
import { SubmitButton } from "@/components/SubmitButton";
import type { RowCondition as StepApproverCondition } from "@/components/StepApproverMatrixRow";
import {
  RULE_TYPE_VALUES,
  RULE_OPERATOR_VALUES,
  OPERATOR_LABELS,
  RULE_TYPES,
  type RuleOperator,
  type RuleType,
} from "@/lib/workflow-rules";
import type { Database } from "@/lib/supabase/types";
import {
  recordStepChangeImpact,
  fetchStepApproverSnapshot,
} from "@/lib/workflow-impact";

type RuleRow = Database["public"]["Tables"]["approval_workflow_rules"]["Row"];

// Parses the class/supplier/customer/category condition fields a
// StepApproverMatrixRow form submits (see components/StepApproverMatrixRow.tsx
// and TagInput.tsx, which emits one hidden input per chip under the same
// name) into the condition rows to persist. Operator "any" (the UI
// sentinel for "no condition") or an empty value list skips that field.
function parseStepConditions(formData: FormData): StepApproverCondition[] {
  const out: StepApproverCondition[] = [];
  for (const field of ["class", "supplier", "customer", "category"] as const) {
    const operator = String(formData.get(`${field}_operator`) ?? "any");
    if (operator !== "matches" && operator !== "not_matches") continue;
    const values = formData.getAll(`${field}_values`).map(String).filter(Boolean);
    if (values.length === 0) continue;
    out.push({ field, operator, match_values: values });
  }
  return out;
}

// ---------------------------------------------------------------------
// Server actions (admin-only via RLS on the workflow tables).
// ---------------------------------------------------------------------

async function createWorkflow(orgId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const isDefault = formData.get("is_default") === "on";

  if (isDefault) {
    await supabase
      .from("approval_workflows")
      .update({ is_default: false })
      .eq("organization_id", orgId);
  }
  await supabase
    .from("approval_workflows")
    .insert({ organization_id: orgId, name, is_default: isDefault });

  revalidatePath("/workflows");
}

async function updateWorkflow(workflowId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const isDefault = formData.get("is_default") === "on";

  const { data: wf } = await supabase
    .from("approval_workflows")
    .select("organization_id")
    .eq("id", workflowId)
    .single();
  if (!wf) return;

  if (isDefault) {
    await supabase
      .from("approval_workflows")
      .update({ is_default: false })
      .eq("organization_id", wf.organization_id)
      .neq("id", workflowId);
  }
  await supabase
    .from("approval_workflows")
    .update({ name, is_default: isDefault })
    .eq("id", workflowId);

  revalidatePath("/workflows");
}

async function deleteWorkflow(workflowId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("approval_workflows").delete().eq("id", workflowId);

  revalidatePath("/workflows");
}

async function addStep(workflowId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  const approvalMode = String(formData.get("approval_mode") ?? "all") === "any" ? "any" : "all";
  const deadlineDays = parseDeadlineDays(formData);

  const { data: last } = await supabase
    .from("approval_workflow_steps")
    .select("step_order")
    .eq("workflow_id", workflowId)
    .order("step_order", { ascending: false })
    .limit(1);
  await supabase.from("approval_workflow_steps").insert({
    workflow_id: workflowId,
    name,
    approval_mode: approvalMode,
    deadline_days: deadlineDays,
    step_order: (last?.[0]?.step_order ?? 0) + 1,
  });

  revalidatePath("/workflows");
}

// Blank/zero/negative all mean "no deadline" — the check constraint only
// allows null or a positive integer.
function parseDeadlineDays(formData: FormData): number | null {
  const raw = String(formData.get("deadline_days") ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function updateStep(stepId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  const approvalMode = String(formData.get("approval_mode") ?? "all") === "any" ? "any" : "all";
  const deadlineDays = parseDeadlineDays(formData);
  await supabase
    .from("approval_workflow_steps")
    .update({ name, approval_mode: approvalMode, deadline_days: deadlineDays })
    .eq("id", stepId);

  revalidatePath("/workflows");
}

async function saveStepApprover(
  stepId: string,
  approverRowId: string,
  formData: FormData
) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const approverUserId = String(formData.get("approver_user_id") ?? "").trim();
  if (!approverUserId) return;
  const isDefault = formData.get("is_default") === "on";
  const conditions = isDefault ? [] : parseStepConditions(formData);

  const { data: step } = await supabase
    .from("approval_workflow_steps")
    .select("workflow_id, step_order, name")
    .eq("id", stepId)
    .single();
  if (!step) return;
  const { data: workflow } = await supabase
    .from("approval_workflows")
    .select("organization_id")
    .eq("id", step.workflow_id)
    .single();
  if (!workflow) return;

  const before = await fetchStepApproverSnapshot(supabase, stepId);
  const isNew = approverRowId === "new";

  let stepApproverId = approverRowId;
  if (approverRowId === "new") {
    const { data: last } = await supabase
      .from("approval_workflow_step_approvers")
      .select("row_order")
      .eq("step_id", stepId)
      .order("row_order", { ascending: false })
      .limit(1);
    const { data: inserted } = await supabase
      .from("approval_workflow_step_approvers")
      .insert({
        step_id: stepId,
        approver_user_id: approverUserId,
        is_default: isDefault,
        row_order: (last?.[0]?.row_order ?? 0) + 1,
      })
      .select("id")
      .single();
    if (!inserted) return;
    stepApproverId = inserted.id;
  } else {
    await supabase
      .from("approval_workflow_step_approvers")
      .update({ approver_user_id: approverUserId, is_default: isDefault })
      .eq("id", approverRowId);
    await supabase
      .from("approval_workflow_step_conditions")
      .delete()
      .eq("step_approver_id", approverRowId);
  }

  if (conditions.length > 0) {
    await supabase.from("approval_workflow_step_conditions").insert(
      conditions.map((c) => ({ ...c, step_approver_id: stepApproverId }))
    );
  }

  const { data: approverProfile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", approverUserId)
    .single();
  const approverLabel = approverProfile?.full_name ?? "an approver";
  const stepLabel = step.name || `Step ${step.step_order}`;
  const after = await fetchStepApproverSnapshot(supabase, stepId);
  await recordStepChangeImpact(supabase, {
    organizationId: workflow.organization_id,
    workflowId: step.workflow_id,
    stepId,
    stepOrder: step.step_order,
    stepLabel,
    actorId: user.id,
    summary: `${isNew ? "Added" : "Updated"} approver ${approverLabel} on step "${stepLabel}"`,
    before,
    after,
  });

  revalidatePath("/workflows");
}

async function deleteStepApprover(approverRowId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: approverRow } = await supabase
    .from("approval_workflow_step_approvers")
    .select("step_id, approver_user_id")
    .eq("id", approverRowId)
    .single();
  if (!approverRow) return;

  const { data: step } = await supabase
    .from("approval_workflow_steps")
    .select("workflow_id, step_order, name")
    .eq("id", approverRow.step_id)
    .single();
  if (!step) return;
  const { data: workflow } = await supabase
    .from("approval_workflows")
    .select("organization_id")
    .eq("id", step.workflow_id)
    .single();
  if (!workflow) return;

  const [before, { data: approverProfile }] = await Promise.all([
    fetchStepApproverSnapshot(supabase, approverRow.step_id),
    supabase.from("profiles").select("full_name").eq("id", approverRow.approver_user_id).single(),
  ]);
  const approverLabel = approverProfile?.full_name ?? "an approver";
  const stepLabel = step.name || `Step ${step.step_order}`;

  await supabase
    .from("approval_workflow_step_approvers")
    .delete()
    .eq("id", approverRowId);

  const after = await fetchStepApproverSnapshot(supabase, approverRow.step_id);
  await recordStepChangeImpact(supabase, {
    organizationId: workflow.organization_id,
    workflowId: step.workflow_id,
    stepId: approverRow.step_id,
    stepOrder: step.step_order,
    stepLabel,
    actorId: user.id,
    summary: `Removed approver ${approverLabel} from step "${stepLabel}"`,
    before,
    after,
  });

  revalidatePath("/workflows");
}

async function deleteStep(stepId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("approval_workflow_steps").delete().eq("id", stepId);

  revalidatePath("/workflows");
}

async function moveStep(stepId: string, direction: "up" | "down") {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: step } = await supabase
    .from("approval_workflow_steps")
    .select("id, workflow_id, step_order")
    .eq("id", stepId)
    .single();
  if (!step) return;

  const { data: steps } = await supabase
    .from("approval_workflow_steps")
    .select("id, step_order")
    .eq("workflow_id", step.workflow_id)
    .order("step_order", { ascending: true });
  const ordered = steps ?? [];
  const idx = ordered.findIndex((s) => s.id === stepId);
  const neighbor = direction === "up" ? ordered[idx - 1] : ordered[idx + 1];
  if (idx < 0 || !neighbor) return;

  // Swap via a temp order so the unique (workflow_id, step_order) never
  // collides mid-update.
  await supabase
    .from("approval_workflow_steps")
    .update({ step_order: -1 })
    .eq("id", stepId);
  await supabase
    .from("approval_workflow_steps")
    .update({ step_order: step.step_order })
    .eq("id", neighbor.id);
  await supabase
    .from("approval_workflow_steps")
    .update({ step_order: neighbor.step_order })
    .eq("id", stepId);

  revalidatePath("/workflows");
}

async function saveRule(
  workflowId: string,
  ruleId: string,
  formData: FormData
) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const type = String(formData.get("rule_type") ?? "") as RuleType;
  const operator = String(formData.get("operator") ?? "") as RuleOperator;
  if (!RULE_TYPE_VALUES.includes(type)) return;
  if (!RULE_OPERATOR_VALUES.includes(operator)) return;

  const value = String(formData.get("value") ?? "").trim() || null;
  const value2 = String(formData.get("value2") ?? "").trim() || null;

  if (ruleId === "new") {
    const { data: last } = await supabase
      .from("approval_workflow_rules")
      .select("rule_order")
      .eq("workflow_id", workflowId)
      .order("rule_order", { ascending: false })
      .limit(1);
    await supabase.from("approval_workflow_rules").insert({
      workflow_id: workflowId,
      rule_type: type,
      operator,
      value,
      value2,
      rule_order: (last?.[0]?.rule_order ?? 0) + 1,
    });
  } else {
    await supabase
      .from("approval_workflow_rules")
      .update({ rule_type: type, operator, value, value2 })
      .eq("id", ruleId);
  }

  revalidatePath("/workflows");
}

async function deleteRule(ruleId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.from("approval_workflow_rules").delete().eq("id", ruleId);

  revalidatePath("/workflows");
}

async function dismissImpactReport(impactId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase
    .from("workflow_change_impacts")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", impactId);

  revalidatePath("/workflows");
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default async function WorkflowsPage() {
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
          Your account isn&apos;t attached to an organization yet. See the
          README first-org-setup steps.
        </p>
      </main>
    );
  }

  const isAdmin = org.role === "admin";
  // Plain "user" members work invoices, not the workflow that routes them —
  // no read-only mirror here, unlike auditor's full-app visibility.
  if (org.role === "user") redirect("/dashboard");

  const { data: pendingImpacts } = isAdmin
    ? await supabase
        .from("workflow_change_impacts")
        .select("*")
        .eq("organization_id", org.id)
        .is("dismissed_at", null)
        .order("created_at", { ascending: false })
        .limit(5)
    : { data: [] };

  const { data: workflows } = await supabase
    .from("approval_workflows")
    .select("*")
    .eq("organization_id", org.id)
    .order("created_at", { ascending: true });

  const workflowIds = (workflows ?? []).map((w) => w.id);

  const { data: steps } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_steps")
          .select("*")
          .in("workflow_id", workflowIds)
          .order("step_order", { ascending: true })
      : { data: [] };
  const { data: rules } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_rules")
          .select("*")
          .in("workflow_id", workflowIds)
          .order("rule_order", { ascending: true })
      : { data: [] };

  const stepIds = (steps ?? []).map((s) => s.id);
  const { data: stepApprovers } =
    stepIds.length > 0
      ? await supabase
          .from("approval_workflow_step_approvers")
          .select("*")
          .in("step_id", stepIds)
          .order("row_order", { ascending: true })
      : { data: [] };
  const stepApproverIds = (stepApprovers ?? []).map((a) => a.id);
  const { data: stepConditions } =
    stepApproverIds.length > 0
      ? await supabase
          .from("approval_workflow_step_conditions")
          .select("*")
          .in("step_approver_id", stepApproverIds)
      : { data: [] };
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name", { ascending: true });
  const projectOptions = (projects ?? []).map((p) => ({ id: p.id, label: p.name }));

  // QBO mirrors feed the matrix cells so approvers pick from the real
  // lists (hundreds of projects/categories/suppliers/classes) instead of
  // free-typing. The stored value is the display string — exactly what an
  // invoice's class/category/supplier holds, so conditions match at runtime.
  const [{ data: qboClassRows }, { data: qboCategoryRows }, qboSupplierRows] =
    await Promise.all([
      supabase
        .from("qbo_classes")
        .select("name")
        .eq("organization_id", org.id)
        .eq("active", true)
        .order("name", { ascending: true }),
      supabase
        .from("qbo_categories")
        .select("name, acct_num")
        .eq("organization_id", org.id)
        .eq("active", true)
        .order("name", { ascending: true }),
      fetchAllQboSuppliers(supabase, org.id),
    ]);
  const classOptions = (qboClassRows ?? []).map((c) => ({
    id: c.name,
    label: c.name,
  }));
  const categoryOptions = (qboCategoryRows ?? []).map((c) => {
    const label = c.acct_num ? `${c.acct_num} - ${c.name}` : c.name;
    return { id: label, label };
  });
  const supplierOptions = (qboSupplierRows ?? []).map((s) => ({
    id: s.name,
    label: s.name,
  }));
  // Org members for the approver selects (auditors can't be approvers).
  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", org.id);
  const memberIds = [...new Set((members ?? []).map((m) => m.user_id))];
  const memberRoleById = new Map(
    (members ?? []).map((m) => [m.user_id, m.role])
  );
  const { data: profiles } =
    memberIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", memberIds)
      : { data: [] };
  // Per-member lookups, not a bulk listUsers({ perPage: 1000 }) — this
  // page's own org has a bounded member list, so fetching up to 1000
  // users platform-wide on every page load was pure waste (same pattern
  // found and fixed on the @mention/assignment/support-chat paths).
  const admin = createAdminClient();
  const memberUserResults = await Promise.all(
    memberIds.map((id) => admin.auth.admin.getUserById(id))
  );
  const emailById = new Map(
    memberIds.map((id, i) => [id, memberUserResults[i].data.user?.email ?? null])
  );
  const approverOptions = (profiles ?? [])
    .filter((p) => memberRoleById.get(p.id) !== "auditor")
    .map((p) => ({
      id: p.id,
      label: p.full_name
        ? `${p.full_name}${emailById.get(p.id) ? ` (${emailById.get(p.id)})` : ""}`
        : emailById.get(p.id) ?? p.id.slice(0, 8),
    }));
  const stepsByWorkflow = new Map<string, typeof steps>();
  for (const s of steps ?? []) {
    const list = stepsByWorkflow.get(s.workflow_id) ?? [];
    list.push(s);
    stepsByWorkflow.set(s.workflow_id, list);
  }
  const rulesByWorkflow = new Map<string, RuleRow[]>();
  for (const r of rules ?? []) {
    const list = rulesByWorkflow.get(r.workflow_id) ?? [];
    list.push(r);
    rulesByWorkflow.set(r.workflow_id, list);
  }
  const approversByStep = new Map<string, typeof stepApprovers>();
  for (const a of stepApprovers ?? []) {
    const list = approversByStep.get(a.step_id) ?? [];
    list.push(a);
    approversByStep.set(a.step_id, list);
  }
  const conditionsByApprover = new Map<string, StepApproverCondition[]>();
  for (const c of stepConditions ?? []) {
    const list = conditionsByApprover.get(c.step_approver_id) ?? [];
    list.push({ field: c.field, operator: c.operator, match_values: c.match_values });
    conditionsByApprover.set(c.step_approver_id, list);
  }

  const inputCls =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <div className="text-sm font-semibold">{org.name}</div>
          <div className="mt-0.5 truncate text-xs text-slate-400">
            Approval workflows
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          <Link
            href="/dashboard"
            className="block rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            ← Back to dashboard
          </Link>
          <Link
            href="/settings"
            className="block rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            Settings
          </Link>
        </nav>
        <div className="flex items-center justify-between border-t border-slate-200 p-4">
          <span className="truncate text-xs text-slate-500">{user.email}</span>
          <SignOutButton />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-8">
          <h1 className="text-2xl font-semibold">Approval workflows</h1>
          <p className="mt-1 text-sm text-slate-500">
            Each workflow has ordered approval steps. A step can have several
            approvers, each eligible only when an invoice&apos;s Class,
            Category, Customer, or Supplier matches their conditions — plus an optional
            default approver used when nobody&apos;s conditions match. One
            workflow with conditional steps can cover every project, instead
            of needing a separate workflow per project. Workflow items below
            (routing rules) only decide which workflow an invoice uses, if
            you have more than one.
          </p>

          {isAdmin && (pendingImpacts ?? []).length > 0 && (
            <div className="mt-4 space-y-3">
              {(pendingImpacts ?? []).map((impact) => (
                <div
                  key={impact.id}
                  className="rounded-lg border border-amber-300 bg-amber-50 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-amber-900">
                        {impact.summary} — affected {impact.affected.length} in-flight{" "}
                        {impact.affected.length === 1 ? "bill" : "bills"}
                      </p>
                      <p className="mt-0.5 text-xs text-amber-700">
                        This app doesn&apos;t &quot;restart&quot; a workflow — the
                        change took effect immediately. Nothing was
                        auto-fixed; review below and reassign anything that
                        needs it.
                      </p>
                    </div>
                    <form action={dismissImpactReport.bind(null, impact.id)}>
                      <SubmitButton className="whitespace-nowrap text-xs text-amber-700 hover:underline">
                        Dismiss
                      </SubmitButton>
                    </form>
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {impact.affected.map((a) => (
                      <li key={a.invoice_id} className="text-sm text-amber-900">
                        <Link
                          href={`/dashboard/${a.invoice_id}`}
                          className="font-medium hover:underline"
                        >
                          {a.invoice_label}
                        </Link>
                        {" — "}
                        {a.before.length > 0 ? a.before.join(", ") : "nobody"}
                        {" → "}
                        {a.after.length > 0 ? (
                          a.after.join(", ")
                        ) : (
                          <span className="font-medium text-red-700">
                            nobody (stuck — needs reassignment)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {isAdmin && (
            <form
              action={createWorkflow.bind(null, org.id)}
              className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-4"
            >
              <input
                name="name"
                required
                placeholder="Workflow name, e.g. High-value approvals"
                className={`${inputCls} min-w-60 flex-1`}
              />
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  name="is_default"
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                />
                Default workflow
              </label>
              <SubmitButton className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Create workflow
              </SubmitButton>
            </form>
          )}

          <div className="mt-6 space-y-6">
            {(workflows ?? []).map((w) => {
              const wfSteps = stepsByWorkflow.get(w.id) ?? [];
              const wfRules = rulesByWorkflow.get(w.id) ?? [];
              return (
                <section
                  key={w.id}
                  className="rounded-lg border border-slate-200 bg-white"
                >
                  <CollapsibleWorkflowSection
                    storageKey={`workflow-collapsed:${w.id}`}
                    title={
                      <>
                        <h2 className="text-base font-semibold text-slate-800">
                          {w.name}
                        </h2>
                        {w.is_default && (
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                            default
                          </span>
                        )}
                      </>
                    }
                    actions={
                      isAdmin && (
                        <>
                          <form
                            action={updateWorkflow.bind(null, w.id)}
                            className="flex items-center gap-2"
                          >
                            <input
                              name="name"
                              defaultValue={w.name}
                              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                            />
                            <label className="flex items-center gap-1 text-xs text-slate-600">
                              <input
                                name="is_default"
                                type="checkbox"
                                defaultChecked={w.is_default}
                                className="h-3.5 w-3.5 rounded border-slate-300"
                              />
                              default
                            </label>
                            <SubmitButton className="rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700">
                              Save
                            </SubmitButton>
                          </form>
                          <form action={deleteWorkflow.bind(null, w.id)}>
                            <SubmitButton className="text-xs text-red-500 hover:underline">
                              Delete
                            </SubmitButton>
                          </form>
                        </>
                      )
                    }
                  >
                  {/* Approval steps */}
                  <div className="px-4 py-3">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                      Approval steps
                    </div>
                    <ol className="mt-2 space-y-3">
                      {wfSteps.map((s, i) => {
                        const stepApproverRows = approversByStep.get(s.id) ?? [];
                        return (
                          <li
                            key={s.id}
                            className="rounded-md border border-slate-200 p-3"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="w-14 text-sm font-medium text-slate-500">
                                Step {i + 1}
                              </span>
                              {isAdmin ? (
                                <form
                                  action={updateStep.bind(null, s.id)}
                                  className="flex flex-1 flex-wrap items-center gap-2"
                                >
                                  <input
                                    name="name"
                                    defaultValue={s.name}
                                    placeholder={`Step ${i + 1} name`}
                                    className="min-w-40 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                                  />
                                  <select
                                    name="approval_mode"
                                    defaultValue={s.approval_mode}
                                    className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                                  >
                                    <option value="all">Require all matching approvers</option>
                                    <option value="any">Require any one approver</option>
                                  </select>
                                  <input
                                    type="number"
                                    name="deadline_days"
                                    min={1}
                                    defaultValue={s.deadline_days ?? ""}
                                    placeholder="Deadline (days)"
                                    title="Days before this step is flagged overdue in the daily digest and, after a grace period, escalated to admins. Leave blank for no deadline."
                                    className="w-32 rounded-md border border-slate-300 px-2 py-1 text-xs"
                                  />
                                  <SubmitButton className="rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700">
                                    Save
                                  </SubmitButton>
                                </form>
                              ) : (
                                <span className="text-sm font-medium text-slate-700">
                                  {s.name || `Step ${i + 1}`} —{" "}
                                  {s.approval_mode === "any"
                                    ? "any one approver"
                                    : "all matching approvers"}
                                  {s.deadline_days != null && ` — ${s.deadline_days}d deadline`}
                                </span>
                              )}
                              {isAdmin && (
                                <>
                                  <form action={moveStep.bind(null, s.id, "up")}>
                                    <SubmitButton
                                      disabled={i === 0}
                                      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                                    >
                                      ↑
                                    </SubmitButton>
                                  </form>
                                  <form action={moveStep.bind(null, s.id, "down")}>
                                    <SubmitButton
                                      disabled={i === wfSteps.length - 1}
                                      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                                    >
                                      ↓
                                    </SubmitButton>
                                  </form>
                                  <form action={deleteStep.bind(null, s.id)}>
                                    <SubmitButton className="text-xs text-red-500 hover:underline">
                                      Remove step
                                    </SubmitButton>
                                  </form>
                                </>
                              )}
                            </div>

                            <div className="mt-2">
                              <StepApproversManager
                                stepName={s.name || `Step ${i + 1}`}
                                approvers={stepApproverRows.map((a) => ({
                                  id: a.id,
                                  approver_user_id: a.approver_user_id,
                                  is_default: a.is_default,
                                  conditions: conditionsByApprover.get(a.id) ?? [],
                                }))}
                                approverOptions={approverOptions}
                                projectOptions={projectOptions}
                                classOptions={classOptions}
                                categoryOptions={categoryOptions}
                                supplierOptions={supplierOptions}
                                saveApprover={isAdmin ? saveStepApprover.bind(null, s.id) : undefined}
                                deleteApprover={isAdmin ? deleteStepApprover : undefined}
                                readOnly={!isAdmin}
                              />
                            </div>
                          </li>
                        );
                      })}
                      {wfSteps.length === 0 && (
                        <li className="text-sm text-slate-400">
                          No steps yet.
                        </li>
                      )}
                    </ol>
                    {isAdmin && (
                      <form
                        action={addStep.bind(null, w.id)}
                        className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-slate-300 p-2"
                      >
                        <input
                          name="name"
                          placeholder={`Step ${wfSteps.length + 1} name, e.g. PM Approval`}
                          className="min-w-48 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                        />
                        <select
                          name="approval_mode"
                          defaultValue="all"
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                        >
                          <option value="all">Require all matching approvers</option>
                          <option value="any">Require any one approver</option>
                        </select>
                        <input
                          type="number"
                          name="deadline_days"
                          min={1}
                          placeholder="Deadline (days)"
                          title="Days before this step is flagged overdue in the daily digest and, after a grace period, escalated to admins. Leave blank for no deadline."
                          className="w-32 rounded-md border border-slate-300 px-2 py-1 text-xs"
                        />
                        <SubmitButton className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Add step
                        </SubmitButton>
                      </form>
                    )}
                  </div>

                  {/* Workflow items (routing rules) */}
                  <div className="border-t border-slate-200 px-4 py-3">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                      Workflow items
                    </div>
                    <div className="mt-2 space-y-2">
                      {wfRules.map((r) => (
                        <WorkflowRuleRow
                          key={r.id}
                          ruleId={r.id}
                          initialType={r.rule_type}
                          initialOperator={r.operator}
                          initialValue={r.value}
                          initialValue2={r.value2}
                          saveRule={saveRule.bind(null, w.id)}
                          deleteRule={isAdmin ? deleteRule : undefined}
                        />
                      ))}
                      {wfRules.length === 0 && (
                        <p className="text-sm text-slate-400">
                          No workflow items — this workflow matches every
                          invoice.
                        </p>
                      )}
                      {isAdmin && (
                        <WorkflowRuleRow
                          ruleId="new"
                          initialType="total_amount"
                          initialOperator="any"
                          initialValue={null}
                          initialValue2={null}
                          saveRule={saveRule.bind(null, w.id)}
                        />
                      )}
                    </div>
                    {!isAdmin && wfRules.length > 0 && (
                      <div className="mt-2 text-sm text-slate-500">
                        {wfRules.map((r) => (
                          <div key={r.id}>
                            {RULE_TYPES.find((t) => t.value === r.rule_type)
                              ?.label ?? r.rule_type}{" "}
                            — {OPERATOR_LABELS[r.operator] ?? r.operator}
                            {r.value ? ` ${r.value}` : ""}
                            {r.value2 ? ` — ${r.value2}` : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  </CollapsibleWorkflowSection>
                </section>
              );
            })}
            {(workflows ?? []).length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
                No workflows yet — create your first one above.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
