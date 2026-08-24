-- 0048: per-org default tax rate for new invoices, and a totals-discrepancy
-- note on invoices.
--
-- 1. organizations.default_tax_rate — the tax rate applied to every new
--    invoice when the supplier has no rule of their own. Set in Settings
--    (below the tax sync section); the value is one of the synced QBO tax
--    code rates (e.g. 13 for H 13%).
-- 2. invoices.totals_note — set at ingestion when the document's printed
--    total disagrees with the line-item derivation. The DOCUMENT total wins
--    ("matches at all costs"); this note tells the reviewer what happened.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists default_tax_rate numeric;

alter table invoices add column if not exists totals_note text;
