-- Approval Flow: "held" status for invoices.
-- Approvers can Hold an in-flight invoice (instead of approving/rejecting);
-- it can be returned to the review queue with Back to Review.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoices drop constraint if exists invoices_status_check;

alter table invoices add constraint invoices_status_check
  check (status in ('pending_review', 'pending', 'in_review', 'held', 'approved', 'rejected', 'paid'));
