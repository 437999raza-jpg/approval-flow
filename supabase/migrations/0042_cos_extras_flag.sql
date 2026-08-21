-- 0042: persist the CO/Extras flag on the invoice.
--
-- Flow: the reviewer (accountant) clears review without seeing this — it is
-- the NEXT approver (usually the project manager) who decides whether the
-- bill has COs/Extras. Once they tick the box and approve, the flag is
-- LOCKED: nobody downstream can remove it, and the line items are classed
-- "Extras" (a real QBO class) at that point.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices add column if not exists has_cos_or_extras boolean
  not null default false;
