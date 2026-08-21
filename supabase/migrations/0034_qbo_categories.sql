-- 0034: QuickBooks categories (Chart of Accounts mirror).
-- READ-ONLY against QuickBooks: we pull the account list so the app can
-- offer categories without ever writing to QBO. No vendor data is fetched.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists qbo_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_account_id text not null, -- QBO Account Id
  name text not null,
  account_type text, -- e.g. Expense, Income, Bank, Accounts Payable
  account_sub_type text, -- e.g. OtherCurrentLiabilities, CashOnHand
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_account_id)
);

alter table qbo_categories enable row level security;

-- Org members (any role) can read the category list.
drop policy if exists "qbo_categories: org members read" on qbo_categories;
create policy "qbo_categories: org members read" on qbo_categories
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_categories: admins manage" on qbo_categories;
create policy "qbo_categories: admins manage" on qbo_categories
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
