-- 0043: let each org configure its own QBO Sales Tax Liability Account,
-- instead of Flow guessing a hardcoded account name ("Sales Tax Payable")
-- that not every company's Chart of Accounts actually has.
--
-- Lives on qbo_connections because it's a per-realm/per-company setting,
-- same as company_name and realm_id — one row per org, admin-only RLS
-- already in place. Flow never creates this account; an admin must pick
-- an existing, active liability account from the synced Chart of Accounts.
-- Only the id is stored — the display name is resolved from qbo_categories
-- (the existing Chart of Accounts mirror) so it can never go stale if the
-- account is renamed in QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_connections add column if not exists tax_liability_account_id text;
