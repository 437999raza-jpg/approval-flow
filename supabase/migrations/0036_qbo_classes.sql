-- 0036: QuickBooks CLASSES (project numbers etc.).
-- HARD RULE: this app NEVER writes to QuickBooks. This table is a
-- read-only mirror of QBO Class entities so new classes added in QBO show
-- up in Flow after a sync. No vendor/customer/project/class/category data
-- is ever written to QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists qbo_classes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_class_id text not null, -- QBO Class Id
  name text not null,
  active boolean not null default true,
  sub_class boolean not null default false,
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_class_id)
);

alter table qbo_classes enable row level security;

-- Org members (any role) can read the class list.
drop policy if exists "qbo_classes: org members read" on qbo_classes;
create policy "qbo_classes: org members read" on qbo_classes
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_classes: admins manage" on qbo_classes;
create policy "qbo_classes: admins manage" on qbo_classes
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));
