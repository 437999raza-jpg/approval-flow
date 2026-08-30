-- A real, stable Supplier entity — today, vendor identity is entirely
-- normalized-text matching (normalizeForMatching, src/lib/matching.ts),
-- fragile whenever the same supplier's name is OCR'd or typed slightly
-- differently across invoices. name_normalized mirrors the exact same
-- regex supplier_defaults already uses (migration 0031/0047) so app-side
-- and DB-side matching agree. Additive only — vendor_name/
-- vendor_name_normalized stay exactly as they are everywhere; no columns
-- dropped, no existing behavior removed.
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  name_normalized text generated always as (
    trim(regexp_replace(lower(trim(name)), '[^a-z0-9]+', ' ', 'g'))
  ) stored,
  qbo_vendor_id text,
  created_at timestamptz not null default now(),
  unique (organization_id, name_normalized)
);

alter table suppliers enable row level security;
drop policy if exists "suppliers: members can read" on suppliers;
create policy "suppliers: members can read" on suppliers
  for select using (is_org_member(organization_id));
-- Ingestion (createInvoiceFromFile) runs under whichever client its
-- caller passed — the admin client when the new ingest cron drives it,
-- but still a plain RLS-bound session client when the browser's own
-- poller does (both are live paths — see ingest-queue.ts). resolveSupplier
-- (src/lib/suppliers.ts) needs INSERT to work either way, same
-- auditor-exclusion as the invoices table itself (auditors can't reach
-- ingestion at all, but mirrored here for defense in depth).
drop policy if exists "suppliers: members can insert" on suppliers;
create policy "suppliers: members can insert" on suppliers
  for insert with check (
    is_org_member(organization_id) and not is_org_auditor(organization_id)
  );

alter table invoices add column if not exists supplier_id uuid references suppliers(id);
alter table supplier_defaults add column if not exists supplier_id uuid references suppliers(id);

-- Backfill: one supplier per distinct normalized vendor name already
-- present, across both invoices and supplier_defaults (a name that only
-- ever appeared in one of the two still needs a row).
insert into suppliers (organization_id, name)
select distinct on (organization_id, trim(regexp_replace(lower(trim(vendor_name)), '[^a-z0-9]+', ' ', 'g')))
  organization_id, vendor_name
from (
  select organization_id, vendor_name from invoices where vendor_name is not null
  union all
  select organization_id, vendor_name from supplier_defaults where vendor_name is not null
) v
on conflict (organization_id, name_normalized) do nothing;

update invoices i
set supplier_id = s.id
from suppliers s
where i.supplier_id is null
  and i.vendor_name is not null
  and s.organization_id = i.organization_id
  and s.name_normalized = trim(regexp_replace(lower(trim(i.vendor_name)), '[^a-z0-9]+', ' ', 'g'));

update supplier_defaults sd
set supplier_id = s.id
from suppliers s
where sd.supplier_id is null
  and sd.vendor_name is not null
  and s.organization_id = sd.organization_id
  and s.name_normalized = trim(regexp_replace(lower(trim(sd.vendor_name)), '[^a-z0-9]+', ' ', 'g'));
