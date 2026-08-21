-- 0040: store the resolved purchase-side rate on tax codes so the bill's
-- Tax field can offer the QBO codes ("H" → 13%) exactly like Dext/
-- ApprovalMax. Read-only mirror — nothing is ever written to QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_tax_codes add column if not exists rate_value numeric;
