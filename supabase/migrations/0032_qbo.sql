-- Approval Flow: QuickBooks Online integration.
--
-- qbo_connections stores the org's OAuth tokens (access + refresh) plus
-- the QBO realm (company) id. RLS: admins only — these are full API
-- credentials, never visible to users/auditors.
--
-- Invoices track their QBO sync state: qbo_bill_id (the created bill),
-- qbo_sync_status (pending/synced/error), qbo_synced_at, qbo_error.
--
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists qbo_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  realm_id text not null,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  company_name text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table qbo_connections enable row level security;

create policy "qbo_connections: admins only" on qbo_connections
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

alter table invoices add column if not exists qbo_bill_id text;
alter table invoices add column if not exists qbo_sync_status text
  check (qbo_sync_status in ('pending', 'synced', 'error'));
alter table invoices add column if not exists qbo_synced_at timestamptz;
alter table invoices add column if not exists qbo_error text;
