-- 0046: back the new Settings -> Suppliers page.
--
-- product_service: a free-text default (no QBO "Item"/ProductService
-- mirror exists in this app yet, so this is just a stored label, not
-- matched against anything or sent to QBO on sync).
--
-- integration: which accounting platform this supplier belongs to.
-- Every supplier today comes from the one QBO connection this org has
-- (qbo_suppliers is otherwise a read-only mirror -- see 0037), but the
-- Suppliers page lets an admin flag Xero/Zoho Books for when those
-- connections exist. Purely informational until then; nothing reads it
-- yet. Defaults every existing + future row to quickbooks_online since
-- that's the only real connection this app supports today.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table supplier_defaults add column if not exists product_service text;

alter table qbo_suppliers add column if not exists integration text not null default 'quickbooks_online';
