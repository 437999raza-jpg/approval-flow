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
create policy "organization_members: admins manage" on organization_members
  for all
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = organization_members.organization_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from organization_members m
      where m.organization_id = organization_members.organization_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
    )
  );
