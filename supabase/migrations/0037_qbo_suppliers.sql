-- 0037: QuickBooks SUPPLIERS (read-only mirror of the Vendor list).
-- HARD RULE: Flow NEVER creates suppliers in QuickBooks. This table is a
-- read-only mirror of QBO Vendor entities so OCR can match an invoice's
-- vendor to the nearest existing supplier. Nothing is ever written to QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists qbo_suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_vendor_id text not null, -- QBO Vendor Id
  name text not null, -- QBO DisplayName
  name_normalized text not null, -- lower/trimmed/collapsed, for matching
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_vendor_id)
);

alter table qbo_suppliers enable row level security;

-- Org members (any role) can read the supplier list.
drop policy if exists "qbo_suppliers: org members read" on qbo_suppliers;
create policy "qbo_suppliers: org members read" on qbo_suppliers
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_suppliers: admins manage" on qbo_suppliers;
create policy "qbo_suppliers: admins manage" on qbo_suppliers
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
