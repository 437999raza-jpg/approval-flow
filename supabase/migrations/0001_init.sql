-- Approval Flow: core schema
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- One row per user, mirrors auth.users so we can join/display names.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  -- local-part of the inbound invoice address: {inbound_email_token}@{INBOUND_EMAIL_DOMAIN}
  inbound_email_token text unique not null default encode(gen_random_bytes(8), 'hex'),
  created_at timestamptz not null default now()
);

create table organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null check (role in ('admin', 'approver', 'submitter')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- An ordered chain of approvers. Start with one default workflow per org;
-- multiple workflows (e.g. by amount threshold) can be added later.
create table approval_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table approval_workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references approval_workflows(id) on delete cascade,
  step_order int not null,
  approver_user_id uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (workflow_id, step_order)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid references approval_workflows(id),
  vendor_name text,
  invoice_number text,
  amount numeric(14, 2),
  currency text not null default 'USD',
  due_date date,
  status text not null default 'pending'
    check (status in ('pending', 'in_review', 'approved', 'rejected', 'paid')),
  source text not null check (source in ('manual', 'email')),
  source_email text,
  file_path text not null,
  file_name text not null,
  submitted_by uuid references profiles(id),
  current_step_order int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table invoice_approvals (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  step_order int not null,
  approver_id uuid references profiles(id),
  decision text not null check (decision in ('approved', 'rejected')),
  comment text,
  decided_at timestamptz not null default now()
);

create table invoice_comments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  author_id uuid references profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete cascade,
  actor_id uuid references profiles(id),
  action text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Raw record of every inbound email the webhook receives, processed or not.
-- Keeps a debugging trail independent of whether an invoice was created.
create table inbound_email_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  from_address text,
  to_address text,
  subject text,
  attachment_count int not null default 0,
  invoice_ids uuid[] not null default '{}',
  processed boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

create index on organization_members (user_id);
create index on invoices (organization_id, status);
create index on invoice_approvals (invoice_id);
create index on audit_log (organization_id, invoice_id);

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table profiles enable row level security;
alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table approval_workflows enable row level security;
alter table approval_workflow_steps enable row level security;
alter table invoices enable row level security;
alter table invoice_approvals enable row level security;
alter table invoice_comments enable row level security;
alter table audit_log enable row level security;
alter table inbound_email_log enable row level security;

create or replace function is_org_member(org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org_id and user_id = auth.uid()
  );
$$;

create policy "profiles: read own" on profiles
  for select using (id = auth.uid());
create policy "profiles: update own" on profiles
  for update using (id = auth.uid());

create policy "organizations: members can read" on organizations
  for select using (is_org_member(id));

create policy "organization_members: members can read roster" on organization_members
  for select using (is_org_member(organization_id));

create policy "approval_workflows: members can read" on approval_workflows
  for select using (is_org_member(organization_id));

create policy "approval_workflow_steps: members can read" on approval_workflow_steps
  for select using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_member(w.organization_id)
    )
  );

create policy "invoices: members can read" on invoices
  for select using (is_org_member(organization_id));
create policy "invoices: members can insert" on invoices
  for insert with check (is_org_member(organization_id));
create policy "invoices: members can update" on invoices
  for update using (is_org_member(organization_id));

create policy "invoice_approvals: members can read" on invoice_approvals
  for select using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );
create policy "invoice_approvals: members can insert" on invoice_approvals
  for insert with check (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

create policy "invoice_comments: members can read" on invoice_comments
  for select using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );
create policy "invoice_comments: members can insert" on invoice_comments
  for insert with check (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

create policy "audit_log: members can read" on audit_log
  for select using (is_org_member(organization_id));

create policy "inbound_email_log: members can read" on inbound_email_log
  for select using (organization_id is not null and is_org_member(organization_id));

-- Note: inserts to invoices/audit_log/inbound_email_log from the inbound-email
-- webhook use the Supabase service role key (src/lib/supabase/admin.ts), which
-- bypasses RLS — the webhook has no logged-in user to check against.

-- ---------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------
-- Create a private "invoices" bucket (Storage > New bucket, Public: off),
-- or via SQL:
-- insert into storage.buckets (id, name, public) values ('invoices', 'invoices', false);

create policy "invoice files: members can read"
  on storage.objects for select
  using (
    bucket_id = 'invoices'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "invoice files: members can upload"
  on storage.objects for insert
  with check (
    bucket_id = 'invoices'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );
