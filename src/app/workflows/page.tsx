import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentOrg } from "@/lib/current-org";
import { SignOutButton } from "@/components/SignOutButton";
import { WorkflowRuleRow } from "@/components/WorkflowRuleRow";
import {
  RULE_TYPE_VALUES,
  RULE_OPERATOR_VALUES,
  OPERATOR_LABELS,
  RULE_TYPES,
  type RuleOperator,
  type RuleType,
} from "@/lib/workflow-rules";
import type { Database } from "@/lib/supabase/types";

type RuleRow = Database["public"]["Tables"]["approval_workflow_rules"]["Row"];

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

  const approver =
    String(formData.get("approver_user_id") ?? "").trim() || null;

  const { data: last } = await supabase
    .from("approval_workflow_steps")
    .select("step_order")
    .eq("workflow_id", workflowId)
    .order("step_order", { ascending: false })
    .limit(1);
  await supabase.from("approval_workflow_steps").insert({
    workflow_id: workflowId,
    approver_user_id: approver,
    step_order: (last?.[0]?.step_order ?? 0) + 1,
  });

  revalidatePath("/workflows");
}

async function updateStep(stepId: string, formData: FormData) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const approver =
    String(formData.get("approver_user_id") ?? "").trim() || null;
  await supabase
    .from("approval_workflow_steps")
    .update({ approver_user_id: approver })
    .eq("id", stepId);

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

  // Org members for the approver selects.
  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", org.id);
  const memberIds = [...new Set((members ?? []).map((m) => m.user_id))];
  const { data: profiles } =
    memberIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", memberIds)
      : { data: [] };
  const admin = createAdminClient();
  const { data: authUsers } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const emailById = new Map(
    (authUsers?.users ?? []).map((u) => [u.id, u.email ?? null])
  );
  const approverOptions = (profiles ?? []).map((p) => ({
    id: p.id,
    label: p.full_name
      ? `${p.full_name}${emailById.get(p.id) ? ` (${emailById.get(p.id)})` : ""}`
      : emailById.get(p.id) ?? p.id.slice(0, 8),
  }));
  const approverName = (id: string | null) =>
    approverOptions.find((o) => o.id === id)?.label ?? "Unassigned";

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
            Each workflow has approval steps (who approves, in order) and
            workflow items (routing rules). An invoice routes to the first
            workflow whose items all match; approvers on it can see the
            project&apos;s invoices.
          </p>

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
              <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Create workflow
              </button>
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
                  <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
                    <h2 className="text-base font-semibold text-slate-800">
                      {w.name}
                    </h2>
                    {w.is_default && (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                        default
                      </span>
                    )}
                    <span className="flex-1" />
                    {isAdmin && (
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
                          <button className="rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700">
                            Save
                          </button>
                        </form>
                        <form action={deleteWorkflow.bind(null, w.id)}>
                          <button className="text-xs text-red-500 hover:underline">
                            Delete
                          </button>
                        </form>
                      </>
                    )}
                  </div>

                  {/* Approval steps */}
                  <div className="px-4 py-3">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                      Approval steps
                    </div>
                    <ol className="mt-2 space-y-2">
                      {wfSteps.map((s, i) => (
                        <li
                          key={s.id}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="w-10 text-sm font-medium text-slate-500">
                            Step {i + 1}
                          </span>
                          {isAdmin ? (
                            <>
                              <form
                                action={updateStep.bind(null, s.id)}
                                className="flex items-center gap-2"
                              >
                                <select
                                  name="approver_user_id"
                                  defaultValue={s.approver_user_id ?? ""}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                                >
                                  <option value="">— unassigned —</option>
                                  {approverOptions.map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {a.label}
                                    </option>
                                  ))}
                                </select>
                                <button className="rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700">
                                  Save
                                </button>
                              </form>
                              <form action={moveStep.bind(null, s.id, "up")}>
                                <button
                                  disabled={i === 0}
                                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                                >
                                  ↑
                                </button>
                              </form>
                              <form action={moveStep.bind(null, s.id, "down")}>
                                <button
                                  disabled={i === wfSteps.length - 1}
                                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                                >
                                  ↓
                                </button>
                              </form>
                              <form action={deleteStep.bind(null, s.id)}>
                                <button className="text-xs text-red-500 hover:underline">
                                  Remove
                                </button>
                              </form>
                            </>
                          ) : (
                            <span className="text-sm text-slate-700">
                              {approverName(s.approver_user_id)}
                            </span>
                          )}
                        </li>
                      ))}
                      {wfSteps.length === 0 && (
                        <li className="text-sm text-slate-400">
                          No steps yet.
                        </li>
                      )}
                    </ol>
                    {isAdmin && (
                      <form
                        action={addStep.bind(null, w.id)}
                        className="mt-2 flex items-center gap-2"
                      >
                        <select
                          name="approver_user_id"
                          defaultValue=""
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                        >
                          <option value="">— choose approver —</option>
                          {approverOptions.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                            </option>
                          ))}
                        </select>
                        <button className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                          Add step
                        </button>
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
