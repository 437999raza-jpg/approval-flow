-- 0058: invoices.document_total — the invoice's PRINTED total, stored
-- separately so edits can re-run the "document total wins" reconciliation:
-- when line items are changed and now match the printed total, the amber
-- note clears; when they still disagree, the document total stays + the
-- note stays. Also backfills existing rows from the saved extraction JSON.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices add column if not exists document_total numeric;

update invoices set document_total = (extraction->>'total_amount')::numeric
  where document_total is null
    and extraction is not null
    and extraction->>'total_amount' is not null
    and (extraction->>'total_amount')::numeric is not null;
