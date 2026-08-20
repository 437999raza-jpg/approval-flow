-- Approval Flow: workflow rules (ApprovalMax-style workflow items) and
-- admin-only management of workflows/steps.
--
-- A workflow routes invoices whose rules all match. Rule types:
-- total_amount (any/between/under/over/equal), requester, supplier,
-- product_service, category, class, customer (any/matches/not_matches).
--
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists approval_workflow_rules (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references approval_workflows(id) on delete cascade,
  rule_type text not null
    check (rule_type in ('total_amount','requester','supplier','product_service','category','class','customer')),
  operator text not null
    check (operator in ('any','between','under','over','equal','matches','not_matches')),
  value text,
  value2 text,
  rule_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists approval_workflow_rules_workflow_idx
  on approval_workflow_rules (workflow_id);

alter table approval_workflow_rules enable row level security;

create policy "workflow_rules: members can read" on approval_workflow_rules
  for select using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_member(w.organization_id)
    )
  );

create policy "workflow_rules: admins manage" on approval_workflow_rules
  for all
  using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  );

-- Admins manage workflows and their steps (members keep read access via
-- the existing read policies).
create policy "approval_workflows: admins manage" on approval_workflows
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

create policy "approval_workflow_steps: admins manage" on approval_workflow_steps
  for all
  using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  );
