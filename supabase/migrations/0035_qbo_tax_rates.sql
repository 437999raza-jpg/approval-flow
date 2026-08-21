-- 0035: QuickBooks tax RATES + CODES (the % and the letter codes used on
-- bills — e.g. "H" = HST 13%, "G" = GST 5%).
-- HARD RULE: this app NEVER writes to QuickBooks. These tables are
-- read-only mirrors of QBO TaxRate/TaxCode entities so Flow can offer the
-- correct tax % and codes on bills. No vendor/customer/project/class/
-- category data is ever pulled or written.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists qbo_tax_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_tax_rate_id text not null, -- QBO TaxRate Id
  name text not null,
  rate_value numeric not null, -- e.g. 5 for 5%
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_tax_rate_id)
);

alter table qbo_tax_rates enable row level security;

-- Org members (any role) can read the tax rate list.
drop policy if exists "qbo_tax_rates: org members read" on qbo_tax_rates;
create policy "qbo_tax_rates: org members read" on qbo_tax_rates
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_tax_rates: admins manage" on qbo_tax_rates;
create policy "qbo_tax_rates: admins manage" on qbo_tax_rates
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));

create table if not exists qbo_tax_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_tax_code_id text not null, -- QBO TaxCode Id
  name text not null, -- e.g. "H", "G", "P", "E", "Z", "M"
  description text,
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_tax_code_id)
);

alter table qbo_tax_codes enable row level security;

-- Org members (any role) can read the tax code list.
drop policy if exists "qbo_tax_codes: org members read" on qbo_tax_codes;
create policy "qbo_tax_codes: org members read" on qbo_tax_codes
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_tax_codes: admins manage" on qbo_tax_codes;
create policy "qbo_tax_codes: admins manage" on qbo_tax_codes
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
