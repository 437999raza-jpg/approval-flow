-- 0068: invoice_approvals never had a DELETE policy at all (only
-- read/insert), so backToReview/overrideStatus/setInvoiceStage's resets of
-- old decisions (so a workflow can re-run cleanly) were silently deleting
-- ZERO rows through the RLS-bound client -- no error surfaced, since
-- Postgres/PostgREST doesn't treat "0 rows matched a policy" as a
-- failure. Symptom: force a rejected invoice back to on_approval / a
-- specific stage, and its stepper still shows the OLD rejected decision
-- (a red X) instead of pending, and decide()'s alreadyDecided check
-- treats the approver as having already voted.
--
-- The three call sites now also route the delete through the admin client
-- directly (defense in depth, since canReview() already confirmed the
-- caller), but this closes the actual gap the way `invoices` already
-- has its own "admins can delete" policy -- so any future admin action
-- that needs to clear decisions works correctly through the plain
-- RLS-bound client too, without having to remember the workaround.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "invoice_approvals: admins can delete" on invoice_approvals;
create policy "invoice_approvals: admins can delete" on invoice_approvals
  for delete using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_admin(i.organization_id)
    )
  );
