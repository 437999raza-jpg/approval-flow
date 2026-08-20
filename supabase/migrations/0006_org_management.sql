-- Approval Flow: projects/customers + invoice assignment.
-- Projects are org-scoped entities (customer/job/class). They can be
-- entered manually now; the qbo_id column is reserved for when QBO sync
-- lands (QBO customers/projects). Invoices link to a project.
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  qbo_id text,
  source text not null default 'manual' check (source in ('manual', 'qbo')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists projects_org_idx on projects (organization_id);

alter table projects enable row level security;

create policy "projects: members can read" on projects
  for select using (is_org_member(organization_id));

create policy "projects: members can insert" on projects
  for insert with check (is_org_member(organization_id));

create policy "projects: members can update" on projects
  for update using (is_org_member(organization_id));

create policy "projects: members can delete" on projects
  for delete using (is_org_member(organization_id));

-- Invoices can be assigned to a project/customer (Bill panel).
alter table invoices add column if not exists project_id uuid
  references projects(id) on delete set null;

-- Member management is admin-only: only admins can invite, change roles,
-- or remove members. The read-roster policy from 0001 still applies.
-- NOTE: the admin check must go through the security-definer helper
-- is_org_admin (see 0007) — querying organization_members directly inside
-- this policy causes infinite recursion.
create or replace function is_org_admin(org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org_id
      and user_id = auth.uid()
      and role = 'admin'
  );
$$;

create policy "organization_members: admins manage" on organization_members
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));
