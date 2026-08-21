-- 0041: flag invoices whose OCR'd vendor did NOT exactly match a QBO
-- supplier. Such bills are visibly marked and cannot sync to QBO until a
-- human picks the correct supplier (exact match). This makes vendor
-- mismatches visible upfront instead of at push time.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices add column if not exists qbo_vendor_matched boolean
  not null default true;
