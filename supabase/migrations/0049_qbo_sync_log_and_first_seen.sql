-- 0049: per-section QBO sync log + first_seen_at on each read-only mirror.
--
-- Settings now shows each QBO mirror section (Classes, Projects, Suppliers,
-- Categories) as:
--   "N on File. Last synced on <date time>"
-- with ONLY the items that were NEW in the most recent sync listed below
-- (blank when nothing new came in).
--
-- 1. qbo_sync_log — one row per org per section holding when that section
--    was last synced. Written by the sync actions BEFORE the upserts, so a
--    section's "new since last sync" = rows whose first_seen_at is >= the
--    log timestamp.
-- 2. first_seen_at — added to every mirror table (and to projects). Set to
--    now() when a row is FIRST inserted; sync upserts never touch it, so it
--    keeps identifying the sync run that introduced the row.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists qbo_sync_log (
  organization_id uuid not null references organizations(id) on delete cascade,
  section text not null check (section in ('taxes', 'classes', 'categories', 'suppliers', 'projects')),
  synced_at timestamptz not null default now(),
  primary key (organization_id, section)
);

alter table qbo_sync_log enable row level security;

-- Org members (any role) can read the sync log.
drop policy if exists "qbo_sync_log: org members read" on qbo_sync_log;
create policy "qbo_sync_log: org members read" on qbo_sync_log
  for select using (is_org_member(organization_id));

-- Admins manage the log (the sync actions write it).
drop policy if exists "qbo_sync_log: admins manage" on qbo_sync_log;
create policy "qbo_sync_log: admins manage" on qbo_sync_log
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));

-- first_seen_at: when this row first entered the mirror. Backfilled from
-- synced_at (or created_at for projects) so rows that already existed are
-- never mistaken for "new in the next sync".
alter table qbo_classes    add column if not exists first_seen_at timestamptz;
update qbo_classes set first_seen_at = synced_at where first_seen_at is null;
alter table qbo_classes    alter column first_seen_at set not null;
alter table qbo_classes    alter column first_seen_at set default now();

alter table qbo_categories add column if not exists first_seen_at timestamptz;
update qbo_categories set first_seen_at = synced_at where first_seen_at is null;
alter table qbo_categories alter column first_seen_at set not null;
alter table qbo_categories alter column first_seen_at set default now();

alter table qbo_suppliers  add column if not exists first_seen_at timestamptz;
update qbo_suppliers set first_seen_at = synced_at where first_seen_at is null;
alter table qbo_suppliers  alter column first_seen_at set not null;
alter table qbo_suppliers  alter column first_seen_at set default now();

alter table projects       add column if not exists first_seen_at timestamptz;
update projects set first_seen_at = created_at where first_seen_at is null;
alter table projects       alter column first_seen_at set not null;
alter table projects       alter column first_seen_at set default now();

create index if not exists qbo_classes_first_seen_idx    on qbo_classes    (organization_id, first_seen_at);
create index if not exists qbo_categories_first_seen_idx on qbo_categories (organization_id, first_seen_at);
create index if not exists qbo_suppliers_first_seen_idx  on qbo_suppliers  (organization_id, first_seen_at);
create index if not exists projects_first_seen_idx       on projects       (organization_id, first_seen_at);
