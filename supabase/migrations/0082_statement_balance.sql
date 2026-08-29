-- 0082: statement-level fields for the reworked detail page — the
-- statement's own printed date/balance (extracted, editable) and a
-- free-text note. Run via `supabase db push` or paste into the
-- Supabase SQL editor.

alter table vendor_statements add column if not exists statement_date date;
alter table vendor_statements add column if not exists statement_balance numeric(14, 2);
alter table vendor_statements add column if not exists note text;
