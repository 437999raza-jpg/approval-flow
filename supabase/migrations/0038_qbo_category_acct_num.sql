-- 0038: store the QBO account number on categories so they display and
-- resolve as "5-15450 - HVAC" (AcctNum + name), and sync back to QBO by
-- account number. Read-only mirror — nothing is ever written to QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_categories add column if not exists acct_num text;
