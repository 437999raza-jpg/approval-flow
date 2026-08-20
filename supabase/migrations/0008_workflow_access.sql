-- Approval Flow: workflow-managed access model.
--
-- Admins see every invoice. Non-admin members only see invoices whose
-- project is covered by an approval workflow in which they are an approver
-- (plus invoices they submitted, and project-less invoices). Projects are
-- linked to workflows via approval_workflow_projects; the workflow manages
-- who sees what — nothing is assigned directly to users.
--
-- Authored by Araza. Idempotent — safe to re-run.

-- Workflow <-> project links (a workflow covers one or more projects).
create table if not exists approval_workflow_projects (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references approval_workflows(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workflow_id, project_id)
);

create index if not exists approval_workflow_projects_project_idx
  on approval_workflow_projects (project_id);

alter table approval_workflow_projects enable row level security;

create policy "workflow_projects: members can read" on approval_workflow_projects
  for select using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_member(w.organization_id)
    )
  );

create policy "workflow_projects: admins manage" on approval_workflow_projects
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

-- Visibility helper (SECURITY DEFINER so it bypasses RLS — no recursion).
create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or exists (
              select 1
              from approval_workflow_projects wp
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where wp.project_id = i.project_id
                and ws.approver_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

-- ---------------------------------------------------------------------
-- Invoices: scope reads/updates to what the user can see.
-- ---------------------------------------------------------------------
drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (can_see_invoice(id));

drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (can_see_invoice(id));

-- ---------------------------------------------------------------------
-- Dependent tables: scope to visible invoices.
-- ---------------------------------------------------------------------
drop policy if exists "invoice_approvals: members can read" on invoice_approvals;
create policy "invoice_approvals: members can read" on invoice_approvals
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_approvals: members can insert" on invoice_approvals;
create policy "invoice_approvals: members can insert" on invoice_approvals
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_comments: members can read" on invoice_comments;
create policy "invoice_comments: members can read" on invoice_comments
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_comments: members can insert" on invoice_comments;
create policy "invoice_comments: members can insert" on invoice_comments
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_documents: members can read" on invoice_documents;
create policy "invoice_documents: members can read" on invoice_documents
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_documents: members can insert" on invoice_documents;
create policy "invoice_documents: members can insert" on invoice_documents
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can read" on invoice_line_items;
create policy "invoice_line_items: members can read" on invoice_line_items
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can insert" on invoice_line_items;
create policy "invoice_line_items: members can insert" on invoice_line_items
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can update" on invoice_line_items;
create policy "invoice_line_items: members can update" on invoice_line_items
  for update using (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can delete" on invoice_line_items;
create policy "invoice_line_items: members can delete" on invoice_line_items
  for delete using (can_see_invoice(invoice_id));

drop policy if exists "audit_log: members can read" on audit_log;
create policy "audit_log: members can read" on audit_log
  for select using (
    is_org_member(organization_id)
    and (invoice_id is null or can_see_invoice(invoice_id))
  );
