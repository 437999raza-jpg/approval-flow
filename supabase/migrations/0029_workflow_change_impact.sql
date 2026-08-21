-- Approval Flow: workflow change impact reports.
--
-- Unlike ApprovalMax, this app doesn't snapshot a workflow onto a bill
-- when it enters approval — effectiveApproversForStep()/is_eligible_approver()
-- are recomputed live from the current workflow definition every time. That
-- means editing a step's approvers/conditions takes effect on every
-- in-flight invoice (on_approval/on_hold) at that step IMMEDIATELY, with no
-- "restart the workflow" step to skip or forget — but also with no warning
-- if the edit strands a bill (its previously-eligible approver no longer
-- matches, and there's no default approver to fall back to).
--
-- Rather than gate saves behind a restart-style prompt, we report the
-- blast radius right after a save: src/app/workflows/page.tsx computes
-- which in-flight invoices at the edited step had their required-approver
-- set change (before vs. after the edit) and, if any did, writes one row
-- here. The Workflows page shows the most recent undismissed row as a
-- banner listing exactly which invoices were affected.
--
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists workflow_change_impacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null references approval_workflows(id) on delete cascade,
  step_id uuid references approval_workflow_steps(id) on delete set null,
  actor_id uuid references profiles(id) on delete set null,
  summary text not null,
  -- Array of { invoice_id, invoice_label, before: string[] (approver
  -- names), after: string[] } — resolved to display names at write time
  -- since the affected invoices/approvers can themselves change later.
  affected jsonb not null default '[]',
  created_at timestamptz not null default now(),
  dismissed_at timestamptz
);

create index if not exists workflow_change_impacts_org_idx
  on workflow_change_impacts (organization_id, dismissed_at, created_at desc);

alter table workflow_change_impacts enable row level security;

drop policy if exists "workflow_change_impacts: admins manage" on workflow_change_impacts;
create policy "workflow_change_impacts: admins manage" on workflow_change_impacts
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));
