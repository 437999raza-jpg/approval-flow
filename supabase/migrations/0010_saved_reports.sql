-- Approval Flow: saved custom reports.
-- Each report stores a JSON config (metric, group-by, filters); the report
-- runner (src/lib/reports.ts) executes it against what the user can see.
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists saved_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists saved_reports_org_idx on saved_reports (organization_id);

alter table saved_reports enable row level security;

create policy "saved_reports: members can read" on saved_reports
  for select using (is_org_member(organization_id));

create policy "saved_reports: members can insert" on saved_reports
  for insert with check (is_org_member(organization_id));

create policy "saved_reports: members can update" on saved_reports
  for update using (is_org_member(organization_id));

create policy "saved_reports: members can delete" on saved_reports
  for delete using (is_org_member(organization_id));
