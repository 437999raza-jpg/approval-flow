-- Approval Flow: fix "new row violates row-level security policy for
-- table invoices" on every new invoice (manual upload AND email
-- ingestion — both go through createInvoiceFromFile's single
-- `.insert(...).select().single()` call).
--
-- Root cause: migration 0008 made "invoices: members can read" use
-- can_see_invoice(id), which re-queries the invoices table by id
-- (`select 1 from invoices i where i.id = inv_id ...`). That's correct
-- for policies on OTHER tables (invoice_approvals/comments/documents/
-- line_items, which need to look the parent invoice up by invoice_id) and
-- for reading already-committed rows. It breaks specifically for
-- `INSERT ... RETURNING`: within the same command, the self-referential
-- subquery can't see the row that command is in the middle of inserting,
-- so can_see_invoice() spuriously returns false and Postgres reports the
-- RETURNING step itself as an RLS violation — even though the INSERT's
-- own WITH CHECK passed and the row is sitting in the table afterward.
--
-- Fix: give `invoices` its own read policy that evaluates the same
-- visibility rule directly against the row's own columns (organization_id/
-- status/project_id/submitted_by/id are all available without a subquery,
-- since this policy is defined ON invoices itself) instead of going
-- through can_see_invoice(id). `can_see_invoice()` itself is untouched —
-- still correct and still used by every other table's policies.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (
    is_org_admin(organization_id)
    or is_org_auditor(organization_id)
    or (
      is_org_member(organization_id)
      and status <> 'on_review'
      and (
        project_id is null
        or submitted_by = auth.uid()
        or exists (
          select 1
          from approval_workflow_projects wp
          join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
          where wp.project_id = invoices.project_id
            and ws.approver_user_id = auth.uid()
        )
        or exists (
          select 1
          from invoice_line_items li
          join approval_workflow_projects wp on wp.project_id = li.project_id
          join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
          where li.invoice_id = invoices.id
            and ws.approver_user_id = auth.uid()
        )
      )
    )
  );

-- Same fix, proactively, for update: no current code path chains .select()
-- after an invoices update, but if one ever does, this avoids the same
-- self-referential-subquery trap on the RETURNING step.
drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (
    (
      is_org_admin(organization_id)
      or is_org_auditor(organization_id)
      or (
        is_org_member(organization_id)
        and status <> 'on_review'
        and (
          project_id is null
          or submitted_by = auth.uid()
          or exists (
            select 1
            from approval_workflow_projects wp
            join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
            where wp.project_id = invoices.project_id
              and ws.approver_user_id = auth.uid()
          )
          or exists (
            select 1
            from invoice_line_items li
            join approval_workflow_projects wp on wp.project_id = li.project_id
            join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
            where li.invoice_id = invoices.id
              and ws.approver_user_id = auth.uid()
          )
        )
      )
    )
    and not is_org_auditor(organization_id)
  );
