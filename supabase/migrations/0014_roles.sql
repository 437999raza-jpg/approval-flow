-- Approval Flow: three roles — user / auditor / admin.
--   admin   : manages the org, sees everything
--   auditor : sees everything, READ-ONLY (no edits, no decisions)
--   user    : works the org (submit/review/approve) within the projects
--             covered by workflows they're on (the can_see_invoice scope)
-- Existing approver/submitter members become 'user'.
-- Authored by Araza. Idempotent — safe to re-run.

alter table organization_members drop constraint if exists organization_members_role_check;

update organization_members set role = 'user' where role in ('approver', 'submitter');

alter table organization_members add constraint organization_members_role_check
  check (role in ('user', 'auditor', 'admin'));

-- Auditor visibility helper (SECURITY DEFINER, bypasses RLS).
create or replace function is_org_auditor(org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org_id
      and user_id = auth.uid()
      and role = 'auditor'
  );
$$;

-- Auditors see every invoice (read), like admins.
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
        or is_org_auditor(i.organization_id)
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
-- Write policies: auditors are read-only.
-- ---------------------------------------------------------------------
drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (can_see_invoice(id) and not is_org_auditor(organization_id));

drop policy if exists "invoice_approvals: members can insert" on invoice_approvals;
create policy "invoice_approvals: members can insert" on invoice_approvals
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_comments: members can insert" on invoice_comments;
create policy "invoice_comments: members can insert" on invoice_comments
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_documents: members can insert" on invoice_documents;
create policy "invoice_documents: members can insert" on invoice_documents
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_line_items: members can insert" on invoice_line_items;
create policy "invoice_line_items: members can insert" on invoice_line_items
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_line_items: members can update" on invoice_line_items;
create policy "invoice_line_items: members can update" on invoice_line_items
  for update using (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_line_items: members can delete" on invoice_line_items;
create policy "invoice_line_items: members can delete" on invoice_line_items
  for delete using (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "projects: members can insert" on projects;
create policy "projects: members can insert" on projects
  for insert with check (is_org_member(organization_id) and not is_org_auditor(organization_id));

drop policy if exists "projects: members can update" on projects;
create policy "projects: members can update" on projects
  for update using (is_org_member(organization_id) and not is_org_auditor(organization_id));

drop policy if exists "projects: members can delete" on projects;
create policy "projects: members can delete" on projects
  for delete using (is_org_member(organization_id) and not is_org_auditor(organization_id));
