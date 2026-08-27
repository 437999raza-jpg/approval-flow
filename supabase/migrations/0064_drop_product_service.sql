-- 0064: drop product_service entirely. The feature (built out fully in
-- migrations 0046 and 0063, plus the corresponding app code) was reverted
-- on 2026-08-27 -- the org manages this through Category instead, and
-- never uses more than one accounting platform (QBO) to justify it.
-- Both columns were confirmed empty (no rows had a value) before dropping.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table supplier_defaults drop column if exists product_service;
alter table invoice_line_items drop column if exists product_service;
