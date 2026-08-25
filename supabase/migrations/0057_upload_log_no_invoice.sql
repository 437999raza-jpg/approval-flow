-- 0057: upload_log gains a 'no_invoice' outcome — for documents that merge
-- into a PDF but yield NO invoice data at all (no number, no total, no line
-- items), the app does NOT create an invoice and marks the queue entry as
-- "No invoice data found" instead of a retryable failure. Blank/unnumbered
-- pages inside a real invoice are never affected (the guard looks at the
-- whole document, and only documents with literally no invoice data are
-- skipped).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table upload_log drop constraint if exists upload_log_status_check;
alter table upload_log add constraint upload_log_status_check
  check (status in ('queued', 'processing', 'done', 'split', 'error', 'no_invoice'));
