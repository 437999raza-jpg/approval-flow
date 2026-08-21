-- Approval Flow: per-supplier default rules (Dext/ApprovalMax-style).
-- Applied automatically at ingestion when a new invoice's extracted vendor
-- name matches: fills Category/Class/Project/Tax rate on every line item,
-- and computes due_date from payment_terms_days (overriding the LLM's
-- guess, since these are business rules a human configured on purpose).
--
-- Matched by normalized vendor name (trim+lower) — there's no first-class
-- Supplier entity yet, same matching already used for duplicate detection
-- and the Document Search "Supplier" filter. Only the fields that map to
-- something real in this app are here — no Integration/Auto-publish/
-- Payment method/Mark as paid/Rebill/etc., since we have no QBO sync to
-- back those with.
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists supplier_defaults (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  vendor_name text not null,
  vendor_name_normalized text generated always as (lower(trim(vendor_name))) stored,
  category text,
  class text,
  project_id uuid references projects(id) on delete set null,
  tax_rate numeric,
  payment_terms_days integer,
  currency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, vendor_name_normalized)
);

create index if not exists supplier_defaults_org_idx on supplier_defaults (organization_id);

alter table supplier_defaults enable row level security;

drop policy if exists "supplier_defaults: members can read" on supplier_defaults;
create policy "supplier_defaults: members can read" on supplier_defaults
  for select using (is_org_member(organization_id));

drop policy if exists "supplier_defaults: members can insert" on supplier_defaults;
create policy "supplier_defaults: members can insert" on supplier_defaults
  for insert with check (is_org_member(organization_id) and not is_org_auditor(organization_id));

drop policy if exists "supplier_defaults: members can update" on supplier_defaults;
create policy "supplier_defaults: members can update" on supplier_defaults
  for update using (is_org_member(organization_id) and not is_org_auditor(organization_id));

drop policy if exists "supplier_defaults: members can delete" on supplier_defaults;
create policy "supplier_defaults: members can delete" on supplier_defaults
  for delete using (is_org_member(organization_id) and not is_org_auditor(organization_id));
