-- Approval Flow: per-line-item project/customer, for bills split across
-- multiple projects. The invoice-level `project_id` (0006) is left in
-- place for old data/simple single-project bills, but new splits are
-- expressed as one project per line item instead.
--
-- Visibility: a "user" role member can see the invoice if they're an
-- approver on a workflow covering the invoice-level project (existing
-- behavior) OR any line item's project (new) — i.e. "any of the involved
-- projects", not "all of them". In practice a bill only ever splits across
-- projects the same PM already covers, so this is deliberately the
-- permissive option, not the strict one.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoice_line_items add column if not exists project_id uuid
  references projects(id) on delete set null;

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
          and i.status <> 'on_review'
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
            or exists (
              select 1
              from invoice_line_items li
              join approval_workflow_projects wp on wp.project_id = li.project_id
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where li.invoice_id = i.id
                and ws.approver_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;
