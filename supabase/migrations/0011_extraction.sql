-- Approval Flow: raw extraction payload on invoices.
-- Holds the full structured extraction from the OpenRouter extraction
-- engine (line items, subtotal, PO number, vendor contact details,
-- customer, …) alongside the mapped columns. Authored by Araza.
-- Idempotent — safe to re-run.
alter table invoices add column if not exists extraction jsonb;
