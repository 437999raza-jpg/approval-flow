-- Approval Flow: accounting instructions (maps to the QBO bill memo /
-- PrivateNote field — internal, not printed on the invoice).
-- Authored by Araza. Idempotent — safe to re-run.
alter table invoices add column if not exists accounting_instructions text;
