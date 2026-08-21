-- Approval Flow: admin override of who's currently holding an invoice.
-- Per-invoice, not per-workflow — editing approval_workflow_steps directly
-- would silently reassign every invoice on that workflow. This column lets
-- an admin push one specific invoice to a different approver without
-- touching the shared workflow template. Cleared automatically once that
-- step is decided or the invoice leaves on_approval/on_hold.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoices add column if not exists step_override_approver_id uuid
  references profiles(id) on delete set null;
