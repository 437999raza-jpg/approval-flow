-- Approval Flow: review is Admin-only; pending_review invoices are not
-- visible to Users.
--
-- can_see_invoice now: admins see everything, auditors see everything
-- (read-only), and users see only non-pending_review invoices in their
-- workflow scope / own submissions / project-less.
-- Authored by Araza. Idempotent — safe to re-run.

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
          and i.status <> 'pending_review'
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
