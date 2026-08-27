-- 0063: invoice_line_items.product_service — carries a supplier rule's
-- Product/Service default (supplier_defaults.product_service, free text,
-- no QBO Item mirror yet) onto each line at ingestion, the same way
-- category/class already do. Not yet sent to QBO on sync — that needs its
-- own QBO Item mirror + matcher (mirroring how Category/Class/Tax/Supplier
-- already work), since Flow never guesses/creates entities in QBO and a
-- QBO Bill's ItemBasedExpenseLineDetail is a different line shape than the
-- AccountBasedExpenseLineDetail this app always sends today.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoice_line_items add column if not exists product_service text;
