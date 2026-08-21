-- Approval Flow: collapse the status set to match ApprovalMax's own
-- (On review / On approval / Approved / Cancelled / Rejected / On hold).
--
-- Old -> new mapping:
--   pending_review        -> on_review
--   pending, in_review    -> on_approval  (the pending/in_review split only
--                                          ever meant "step 1" vs "step 2+";
--                                          nothing in the app treated them
--                                          differently)
--   held                  -> on_hold
--   approved              -> approved     (unchanged)
--   rejected              -> rejected     (unchanged)
--   paid                  -> approved     (payment status isn't tracked
--                                          separately yet; drop rather than
--                                          keep an always-unused value)
--   (new) cancelled       -- the submitter or an admin can now withdraw a
--                            document before it's decided
-- Authored by Araza. Idempotent — safe to re-run (the UPDATE statements are
-- no-ops once every row is already on a new-style status).

alter table invoices drop constraint if exists invoices_status_check;

update invoices set status = 'on_review' where status = 'pending_review';
update invoices set status = 'on_approval' where status in ('pending', 'in_review');
update invoices set status = 'on_hold' where status = 'held';
update invoices set status = 'approved' where status = 'paid';

alter table invoices add constraint invoices_status_check
  check (status in ('on_review', 'on_approval', 'approved', 'cancelled', 'rejected', 'on_hold'));

alter table invoices alter column status set default 'on_review';

-- Re-point the visibility helper (0015) at the renamed review status.
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
          )
        )
      )
  );
$$;
