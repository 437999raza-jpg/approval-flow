-- Approval Flow: review queue status.
-- New invoices land in "pending_review" (the Pending Review queue). Review
-- Done moves them to "pending" (approval workflow); Back to Review returns
-- non-approved invoices to "pending_review" and resets decisions.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoices drop constraint if exists invoices_status_check;

alter table invoices add constraint invoices_status_check
  check (status in ('pending_review', 'pending', 'in_review', 'approved', 'rejected', 'paid'));
