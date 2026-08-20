-- Approval Flow: notes column on invoices (for the Info > Notes panel).
-- Authored by Araza. Idempotent — safe to re-run.
alter table invoices add column if not exists notes text;
