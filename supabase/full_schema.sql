-- Approval Flow: COMPLETE schema bundle (0001-0059), for a FRESH production
-- Supabase project only. Do NOT run on an existing database.
-- Generated 2026-08-21. Paste into the SQL editor and run once.

--------------------------------------------------------------------
-- >>> supabase/migrations/0001_init.sql
--------------------------------------------------------------------
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

--------------------------------------------------------------------
-- >>> supabase/migrations/0002_approval_hardening.sql
--------------------------------------------------------------------
-- Approval Flow: approval hardening + comments/audit support.
-- Authored by Araza.
-- Run after 0001_init.sql. This migration is idempotent: safe to re-run
-- any number of times (each statement checks whether it already ran).

-- 1) One decision per invoice step. Makes duplicate approve/reject rows
--    impossible even when two approvers race, and gives app code a
--    constraint it can rely on for idempotency.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_approvals_invoice_step_unique'
      and conrelid = 'invoice_approvals'::regclass
  ) then
    alter table invoice_approvals
      add constraint invoice_approvals_invoice_step_unique unique (invoice_id, step_order);
  end if;
end $$;

-- 2) Chat history is read in chronological order per invoice.
create index if not exists invoice_comments_invoice_created_idx
  on invoice_comments (invoice_id, created_at);

-- 3) Let org members see each other's profile names, so comment authors and
--    approver names can be displayed (and included in the audit document).
--    Scoped: the viewer and the target profile must share at least one
--    organization. Complements the existing "profiles: read own" policy.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles: org members can read'
  ) then
    create policy "profiles: org members can read" on profiles
      for select using (
        exists (
          select 1
          from organization_members viewer
          join organization_members target
            on target.organization_id = viewer.organization_id
          where viewer.user_id = auth.uid()
            and target.user_id = profiles.id
        )
      );
  end if;
end $$;

--------------------------------------------------------------------
-- >>> supabase/migrations/0003_multi_documents.sql
--------------------------------------------------------------------
-- Approval Flow: multiple documents per invoice (invoice + extra pages).
-- The primary document stays on invoices.file_path; every additional page
-- (scans, attachments, revisions) lives here. ALL documents are attached
-- to the QBO bill on sync, alongside the audit-trail PDF.
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists invoice_documents (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  file_path text not null,
  file_name text not null,
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists invoice_documents_invoice_idx
  on invoice_documents (invoice_id);

alter table invoice_documents enable row level security;

create policy "invoice_documents: members can read" on invoice_documents
  for select using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

create policy "invoice_documents: members can insert" on invoice_documents
  for insert with check (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0004_instructions.sql
--------------------------------------------------------------------
-- Approval Flow: accounting instructions (maps to the QBO bill memo /
-- PrivateNote field — internal, not printed on the invoice).
-- Authored by Araza. Idempotent — safe to re-run.
alter table invoices add column if not exists accounting_instructions text;

--------------------------------------------------------------------
-- >>> supabase/migrations/0005_bill_editing.sql
--------------------------------------------------------------------
-- Approval Flow: editable bill fields + line items.
-- invoices gains bill_date (defaults to created_at when null) and
-- tax_amount; line-item rows live in invoice_line_items (Category,
-- Description, Tax, Class, Amount, Linked) and push to QBO line items.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoices add column if not exists bill_date date;
alter table invoices add column if not exists tax_amount numeric(14, 2);

create table if not exists invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  category text,
  description text,
  tax_rate numeric(5, 2),
  class text,
  amount numeric(14, 2),
  linked boolean not null default false,
  line_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists invoice_line_items_invoice_idx
  on invoice_line_items (invoice_id);

alter table invoice_line_items enable row level security;

create policy "invoice_line_items: members can read" on invoice_line_items
  for select using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

create policy "invoice_line_items: members can insert" on invoice_line_items
  for insert with check (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

create policy "invoice_line_items: members can update" on invoice_line_items
  for update using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

create policy "invoice_line_items: members can delete" on invoice_line_items
  for delete using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_member(i.organization_id)
    )
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0006_org_management.sql
--------------------------------------------------------------------
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

--------------------------------------------------------------------
-- >>> supabase/migrations/0007_fix_org_admin_policy.sql
--------------------------------------------------------------------
-- Fix: the 0006 "organization_members: admins manage" policy recursed
-- infinitely. It queried organization_members directly inside its own
-- policy, so ANY read of the table (e.g. the dashboard's current-org
-- lookup) failed with "infinite recursion detected in policy".
--
-- Fix: an admin check that runs with SECURITY DEFINER (bypasses RLS), so
-- evaluating the policy no longer re-enters the table's policies.
-- Authored by Araza. Idempotent — safe to re-run.

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

drop policy if exists "organization_members: admins manage" on organization_members;

create policy "organization_members: admins manage" on organization_members
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0008_workflow_access.sql
--------------------------------------------------------------------
-- Approval Flow: workflow-managed access model.
--
-- Admins see every invoice. Non-admin members only see invoices whose
-- project is covered by an approval workflow in which they are an approver
-- (plus invoices they submitted, and project-less invoices). Projects are
-- linked to workflows via approval_workflow_projects; the workflow manages
-- who sees what — nothing is assigned directly to users.
--
-- Authored by Araza. Idempotent — safe to re-run.

-- Workflow <-> project links (a workflow covers one or more projects).
create table if not exists approval_workflow_projects (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references approval_workflows(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workflow_id, project_id)
);

create index if not exists approval_workflow_projects_project_idx
  on approval_workflow_projects (project_id);

alter table approval_workflow_projects enable row level security;

create policy "workflow_projects: members can read" on approval_workflow_projects
  for select using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_member(w.organization_id)
    )
  );

create policy "workflow_projects: admins manage" on approval_workflow_projects
  for all
  using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  );

-- Visibility helper (SECURITY DEFINER so it bypasses RLS — no recursion).
create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or exists (
              select 1
              from approval_workflow_projects wp
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where wp.project_id = i.project_id
                and ws.approver_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

-- ---------------------------------------------------------------------
-- Invoices: scope reads/updates to what the user can see.
-- ---------------------------------------------------------------------
drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (can_see_invoice(id));

drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (can_see_invoice(id));

-- ---------------------------------------------------------------------
-- Dependent tables: scope to visible invoices.
-- ---------------------------------------------------------------------
drop policy if exists "invoice_approvals: members can read" on invoice_approvals;
create policy "invoice_approvals: members can read" on invoice_approvals
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_approvals: members can insert" on invoice_approvals;
create policy "invoice_approvals: members can insert" on invoice_approvals
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_comments: members can read" on invoice_comments;
create policy "invoice_comments: members can read" on invoice_comments
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_comments: members can insert" on invoice_comments;
create policy "invoice_comments: members can insert" on invoice_comments
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_documents: members can read" on invoice_documents;
create policy "invoice_documents: members can read" on invoice_documents
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_documents: members can insert" on invoice_documents;
create policy "invoice_documents: members can insert" on invoice_documents
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can read" on invoice_line_items;
create policy "invoice_line_items: members can read" on invoice_line_items
  for select using (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can insert" on invoice_line_items;
create policy "invoice_line_items: members can insert" on invoice_line_items
  for insert with check (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can update" on invoice_line_items;
create policy "invoice_line_items: members can update" on invoice_line_items
  for update using (can_see_invoice(invoice_id));

drop policy if exists "invoice_line_items: members can delete" on invoice_line_items;
create policy "invoice_line_items: members can delete" on invoice_line_items
  for delete using (can_see_invoice(invoice_id));

drop policy if exists "audit_log: members can read" on audit_log;
create policy "audit_log: members can read" on audit_log
  for select using (
    is_org_member(organization_id)
    and (invoice_id is null or can_see_invoice(invoice_id))
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0009_workflow_rules.sql
--------------------------------------------------------------------
-- Approval Flow: workflow rules (ApprovalMax-style workflow items) and
-- admin-only management of workflows/steps.
--
-- A workflow routes invoices whose rules all match. Rule types:
-- total_amount (any/between/under/over/equal), requester, supplier,
-- product_service, category, class, customer (any/matches/not_matches).
--
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists approval_workflow_rules (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references approval_workflows(id) on delete cascade,
  rule_type text not null
    check (rule_type in ('total_amount','requester','supplier','product_service','category','class','customer')),
  operator text not null
    check (operator in ('any','between','under','over','equal','matches','not_matches')),
  value text,
  value2 text,
  rule_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists approval_workflow_rules_workflow_idx
  on approval_workflow_rules (workflow_id);

alter table approval_workflow_rules enable row level security;

create policy "workflow_rules: members can read" on approval_workflow_rules
  for select using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_member(w.organization_id)
    )
  );

create policy "workflow_rules: admins manage" on approval_workflow_rules
  for all
  using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  );

-- Admins manage workflows and their steps (members keep read access via
-- the existing read policies).
create policy "approval_workflows: admins manage" on approval_workflows
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

create policy "approval_workflow_steps: admins manage" on approval_workflow_steps
  for all
  using (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflows w
      where w.id = workflow_id and is_org_admin(w.organization_id)
    )
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0010_saved_reports.sql
--------------------------------------------------------------------
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

--------------------------------------------------------------------
-- >>> supabase/migrations/0011_extraction.sql
--------------------------------------------------------------------
-- Approval Flow: raw extraction payload on invoices.
-- Holds the full structured extraction from the OpenRouter extraction
-- engine (line items, subtotal, PO number, vendor contact details,
-- customer, …) alongside the mapped columns. Authored by Araza.
-- Idempotent — safe to re-run.
alter table invoices add column if not exists extraction jsonb;

--------------------------------------------------------------------
-- >>> supabase/migrations/0012_review_queue.sql
--------------------------------------------------------------------
-- Approval Flow: review queue status.
-- New invoices land in "pending_review" (the Pending Review queue). Review
-- Done moves them to "pending" (approval workflow); Back to Review returns
-- non-approved invoices to "pending_review" and resets decisions.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoices drop constraint if exists invoices_status_check;

alter table invoices add constraint invoices_status_check
  check (status in ('pending_review', 'pending', 'in_review', 'approved', 'rejected', 'paid'));

--------------------------------------------------------------------
-- >>> supabase/migrations/0013_held_status.sql
--------------------------------------------------------------------
-- Approval Flow: "held" status for invoices.
-- Approvers can Hold an in-flight invoice (instead of approving/rejecting);
-- it can be returned to the review queue with Back to Review.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoices drop constraint if exists invoices_status_check;

alter table invoices add constraint invoices_status_check
  check (status in ('pending_review', 'pending', 'in_review', 'held', 'approved', 'rejected', 'paid'));

--------------------------------------------------------------------
-- >>> supabase/migrations/0014_roles.sql
--------------------------------------------------------------------
-- Approval Flow: three roles — user / auditor / admin.
--   admin   : manages the org, sees everything
--   auditor : sees everything, READ-ONLY (no edits, no decisions)
--   user    : works the org (submit/review/approve) within the projects
--             covered by workflows they're on (the can_see_invoice scope)
-- Existing approver/submitter members become 'user'.
-- Authored by Araza. Idempotent — safe to re-run.

alter table organization_members drop constraint if exists organization_members_role_check;

update organization_members set role = 'user' where role in ('approver', 'submitter');

alter table organization_members add constraint organization_members_role_check
  check (role in ('user', 'auditor', 'admin'));

-- Auditor visibility helper (SECURITY DEFINER, bypasses RLS).
create or replace function is_org_auditor(org_id uuid)
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
      and role = 'auditor'
  );
$$;

-- Auditors see every invoice (read), like admins.
create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or is_org_auditor(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or exists (
              select 1
              from approval_workflow_projects wp
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where wp.project_id = i.project_id
                and ws.approver_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

-- ---------------------------------------------------------------------
-- Write policies: auditors are read-only.
-- ---------------------------------------------------------------------
drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (can_see_invoice(id) and not is_org_auditor(organization_id));

drop policy if exists "invoice_approvals: members can insert" on invoice_approvals;
create policy "invoice_approvals: members can insert" on invoice_approvals
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_comments: members can insert" on invoice_comments;
create policy "invoice_comments: members can insert" on invoice_comments
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_documents: members can insert" on invoice_documents;
create policy "invoice_documents: members can insert" on invoice_documents
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_line_items: members can insert" on invoice_line_items;
create policy "invoice_line_items: members can insert" on invoice_line_items
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_line_items: members can update" on invoice_line_items;
create policy "invoice_line_items: members can update" on invoice_line_items
  for update using (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "invoice_line_items: members can delete" on invoice_line_items;
create policy "invoice_line_items: members can delete" on invoice_line_items
  for delete using (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

drop policy if exists "projects: members can insert" on projects;
create policy "projects: members can insert" on projects
  for insert with check (is_org_member(organization_id) and not is_org_auditor(organization_id));

drop policy if exists "projects: members can update" on projects;
create policy "projects: members can update" on projects
  for update using (is_org_member(organization_id) and not is_org_auditor(organization_id));

drop policy if exists "projects: members can delete" on projects;
create policy "projects: members can delete" on projects
  for delete using (is_org_member(organization_id) and not is_org_auditor(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0015_admin_review.sql
--------------------------------------------------------------------
-- Approval Flow: review is Admin-only; pending_review invoices are not
-- visible to Users.
--
-- can_see_invoice now: admins see everything, auditors see everything
-- (read-only), and users see only non-pending_review invoices in their
-- workflow scope / own submissions / project-less.
-- Authored by Araza. Idempotent — safe to re-run.

create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or is_org_auditor(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and i.status <> 'pending_review'
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or exists (
              select 1
              from approval_workflow_projects wp
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where wp.project_id = i.project_id
                and ws.approver_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

--------------------------------------------------------------------
-- >>> supabase/migrations/0016_avatars.sql
--------------------------------------------------------------------
-- Approval Flow: profile photo storage.
-- Profiles already have `avatar_url` (migration 0001) but nothing has ever
-- written to it. This adds a public "avatars" bucket with per-user upload
-- policies: each user may only write to their own folder, path convention
-- {user_id}/avatar.{ext}. Reads are public since avatar images aren't
-- sensitive and this avoids re-signing a URL everywhere one is displayed.
-- Authored by Araza. Idempotent — safe to re-run.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars: public read" on storage.objects;
create policy "avatars: public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatars: users manage their own" on storage.objects;
create policy "avatars: users manage their own"
  on storage.objects for all
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

--------------------------------------------------------------------
-- >>> supabase/migrations/0017_simplify_statuses.sql
--------------------------------------------------------------------
-- Approval Flow: collapse the status set to match ApprovalMax's own
-- (On review / On approval / Approved / Cancelled / Rejected / On hold).
--
-- Old -> new mapping:
--   pending_review        -> on_review
--   pending, in_review    -> on_approval  (the pending/in_review split only
--                                          ever meant "step 1" vs "step 2+";
--                                          nothing in the app treated them
--                                          differently)
--   held                  -> on_hold
--   approved              -> approved     (unchanged)
--   rejected              -> rejected     (unchanged)
--   paid                  -> approved     (payment status isn't tracked
--                                          separately yet; drop rather than
--                                          keep an always-unused value)
--   (new) cancelled       -- the submitter or an admin can now withdraw a
--                            document before it's decided
-- Authored by Araza. Idempotent — safe to re-run (the UPDATE statements are
-- no-ops once every row is already on a new-style status).

alter table invoices drop constraint if exists invoices_status_check;

update invoices set status = 'on_review' where status = 'pending_review';
update invoices set status = 'on_approval' where status in ('pending', 'in_review');
update invoices set status = 'on_hold' where status = 'held';
update invoices set status = 'approved' where status = 'paid';

alter table invoices add constraint invoices_status_check
  check (status in ('on_review', 'on_approval', 'approved', 'cancelled', 'rejected', 'on_hold'));

alter table invoices alter column status set default 'on_review';

-- Re-point the visibility helper (0015) at the renamed review status.
create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or is_org_auditor(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and i.status <> 'on_review'
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or exists (
              select 1
              from approval_workflow_projects wp
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where wp.project_id = i.project_id
                and ws.approver_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

--------------------------------------------------------------------
-- >>> supabase/migrations/0018_admin_override.sql
--------------------------------------------------------------------
-- Approval Flow: admin override of who's currently holding an invoice.
-- Per-invoice, not per-workflow — editing approval_workflow_steps directly
-- would silently reassign every invoice on that workflow. This column lets
-- an admin push one specific invoice to a different approver without
-- touching the shared workflow template. Cleared automatically once that
-- step is decided or the invoice leaves on_approval/on_hold.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoices add column if not exists step_override_approver_id uuid
  references profiles(id) on delete set null;

--------------------------------------------------------------------
-- >>> supabase/migrations/0019_line_item_projects.sql
--------------------------------------------------------------------
-- Approval Flow: per-line-item project/customer, for bills split across
-- multiple projects. The invoice-level `project_id` (0006) is left in
-- place for old data/simple single-project bills, but new splits are
-- expressed as one project per line item instead.
--
-- Visibility: a "user" role member can see the invoice if they're an
-- approver on a workflow covering the invoice-level project (existing
-- behavior) OR any line item's project (new) — i.e. "any of the involved
-- projects", not "all of them". In practice a bill only ever splits across
-- projects the same PM already covers, so this is deliberately the
-- permissive option, not the strict one.
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoice_line_items add column if not exists project_id uuid
  references projects(id) on delete set null;

create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or is_org_auditor(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and i.status <> 'on_review'
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or exists (
              select 1
              from approval_workflow_projects wp
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where wp.project_id = i.project_id
                and ws.approver_user_id = auth.uid()
            )
            or exists (
              select 1
              from invoice_line_items li
              join approval_workflow_projects wp on wp.project_id = li.project_id
              join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
              where li.invoice_id = i.id
                and ws.approver_user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

--------------------------------------------------------------------
-- >>> supabase/migrations/0020_supplier_defaults.sql
--------------------------------------------------------------------
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

--------------------------------------------------------------------
-- >>> supabase/migrations/0021_fix_invoice_insert_rls.sql
--------------------------------------------------------------------
-- Approval Flow: fix "new row violates row-level security policy for
-- table invoices" on every new invoice (manual upload AND email
-- ingestion — both go through createInvoiceFromFile's single
-- `.insert(...).select().single()` call).
--
-- Root cause: migration 0008 made "invoices: members can read" use
-- can_see_invoice(id), which re-queries the invoices table by id
-- (`select 1 from invoices i where i.id = inv_id ...`). That's correct
-- for policies on OTHER tables (invoice_approvals/comments/documents/
-- line_items, which need to look the parent invoice up by invoice_id) and
-- for reading already-committed rows. It breaks specifically for
-- `INSERT ... RETURNING`: within the same command, the self-referential
-- subquery can't see the row that command is in the middle of inserting,
-- so can_see_invoice() spuriously returns false and Postgres reports the
-- RETURNING step itself as an RLS violation — even though the INSERT's
-- own WITH CHECK passed and the row is sitting in the table afterward.
--
-- Fix: give `invoices` its own read policy that evaluates the same
-- visibility rule directly against the row's own columns (organization_id/
-- status/project_id/submitted_by/id are all available without a subquery,
-- since this policy is defined ON invoices itself) instead of going
-- through can_see_invoice(id). `can_see_invoice()` itself is untouched —
-- still correct and still used by every other table's policies.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (
    is_org_admin(organization_id)
    or is_org_auditor(organization_id)
    or (
      is_org_member(organization_id)
      and status <> 'on_review'
      and (
        project_id is null
        or submitted_by = auth.uid()
        or exists (
          select 1
          from approval_workflow_projects wp
          join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
          where wp.project_id = invoices.project_id
            and ws.approver_user_id = auth.uid()
        )
        or exists (
          select 1
          from invoice_line_items li
          join approval_workflow_projects wp on wp.project_id = li.project_id
          join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
          where li.invoice_id = invoices.id
            and ws.approver_user_id = auth.uid()
        )
      )
    )
  );

-- Same fix, proactively, for update: no current code path chains .select()
-- after an invoices update, but if one ever does, this avoids the same
-- self-referential-subquery trap on the RETURNING step.
drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (
    (
      is_org_admin(organization_id)
      or is_org_auditor(organization_id)
      or (
        is_org_member(organization_id)
        and status <> 'on_review'
        and (
          project_id is null
          or submitted_by = auth.uid()
          or exists (
            select 1
            from approval_workflow_projects wp
            join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
            where wp.project_id = invoices.project_id
              and ws.approver_user_id = auth.uid()
          )
          or exists (
            select 1
            from invoice_line_items li
            join approval_workflow_projects wp on wp.project_id = li.project_id
            join approval_workflow_steps ws on ws.workflow_id = wp.workflow_id
            where li.invoice_id = invoices.id
              and ws.approver_user_id = auth.uid()
          )
        )
      )
    )
    and not is_org_auditor(organization_id)
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0022_invoice_delete.sql
--------------------------------------------------------------------
-- Approval Flow: admin-only permanent invoice deletion.
--
-- 1. audit_log.invoice_id currently cascades on invoice delete, which
--    would wipe out the very "invoice.deleted" entry recording the
--    deletion the moment it happens — the one event that most needs to
--    survive. Switch to "on delete set null": historical audit rows stay
--    (with invoice_id now null, invoice_number/vendor already live in
--    metadata for anything logged going forward), only the FK link goes.
-- 2. invoices had no DELETE policy at all (RLS defaults to deny), so this
--    also adds one, admin-only. Every child table (line items, documents,
--    comments, approvals) already cascades on invoice delete (0001/0003/
--    0005), so a single row delete is enough.
--
-- Authored by Araza. Idempotent — safe to re-run.

alter table audit_log drop constraint if exists audit_log_invoice_id_fkey;
alter table audit_log
  add constraint audit_log_invoice_id_fkey
  foreign key (invoice_id) references invoices(id) on delete set null;

drop policy if exists "invoices: admins can delete" on invoices;
create policy "invoices: admins can delete" on invoices
  for delete using (is_org_admin(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0023_audit_log_insert_policy.sql
--------------------------------------------------------------------
-- Approval Flow: audit_log had RLS enabled (migration 0001) but no INSERT
-- policy was ever added for it — only a SELECT policy. With RLS enabled
-- and no matching policy, Postgres denies by default, so every audit_log
-- insert made through the regular (non-service-role) client has been
-- silently failing since day one: decide/cancelInvoice/reassignApprover/
-- overrideStatus/reExtract and everything added this session (bill edits,
-- line item changes, document uploads, accounting instructions, invoice
-- deletion) never actually wrote a row. Only the inbound-email webhook
-- (which uses the service-role key, bypassing RLS) ever succeeded — which
-- is exactly the one row that showed up when checking the table.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "audit_log: members can insert" on audit_log;
create policy "audit_log: members can insert" on audit_log
  for insert with check (is_org_member(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0024_pending_invoice_splits.sql
--------------------------------------------------------------------
-- Approval Flow: multi-invoice upload splitting.
--
-- A multi-page upload might be one invoice plus supporting pages (handled
-- fine today, the whole file becomes one invoice) or several separate
-- invoices stapled into one file (today silently becomes just one
-- invoice, dropping the rest). When classification detects more than one
-- invoice in a single upload, the file lands here instead of becoming
-- invoices outright — a human reviews and confirms the split (or
-- dismisses it and re-uploads pages separately) before any invoice
-- records are created. Applies to both manual upload and inbound email.
--
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists pending_invoice_splits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  source text not null check (source in ('manual', 'email')),
  source_email text,
  submitted_by uuid references profiles(id) on delete set null,
  file_path text not null,
  file_name text not null,
  page_count integer not null,
  -- [{ "pages": [1,2], "vendorHint": string|null, "invoiceNumberHint": string|null }, ...]
  groups jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null
);

create index if not exists pending_invoice_splits_org_status_idx
  on pending_invoice_splits (organization_id, status);

alter table pending_invoice_splits enable row level security;

drop policy if exists "pending_invoice_splits: members can read" on pending_invoice_splits;
create policy "pending_invoice_splits: members can read" on pending_invoice_splits
  for select using (is_org_member(organization_id));

drop policy if exists "pending_invoice_splits: members can insert" on pending_invoice_splits;
create policy "pending_invoice_splits: members can insert" on pending_invoice_splits
  for insert with check (is_org_member(organization_id));

drop policy if exists "pending_invoice_splits: members can update" on pending_invoice_splits;
create policy "pending_invoice_splits: members can update" on pending_invoice_splits
  for update using (is_org_member(organization_id) and not is_org_auditor(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0025_storage_delete_policy.sql
--------------------------------------------------------------------
-- Approval Flow: the "invoices" storage bucket had SELECT and INSERT
-- policies (migration 0001) but no DELETE policy — same silent-failure
-- class as migration 0023's audit_log gap. Supabase Storage's .remove()
-- doesn't throw when RLS blocks it; it just returns an empty result, so
-- every file-cleanup call has been a no-op: admin invoice deletion
-- (deleteInvoiceAction) never actually removed the file from Storage,
-- and confirming/dismissing a multi-invoice split never removed the
-- original combined upload either. Confirmed by testing directly: an
-- authenticated member's .remove() call against a real file returned []
-- with no error, and the file was still downloadable afterward.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "invoice files: members can delete" on storage.objects;
create policy "invoice files: members can delete"
  on storage.objects for delete
  using (
    bucket_id = 'invoices'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0026_mentions_notifications.sql
--------------------------------------------------------------------
-- Approval Flow: @mention teammates in Discussion, with an in-app
-- notification and (separately, app-side via Resend) an email so they
-- don't have to have the app open to find out.
--
-- mentioned_user_ids lives on invoice_comments itself (resolved
-- server-side from the composer's @mention picks, not parsed from free
-- text) so the comment always knows exactly who it was addressed to.
-- notifications is the in-app "you were mentioned" inbox — one row per
-- (comment, mentioned user), marked read when they open that invoice's
-- Discussion or the notification directly.
--
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoice_comments
  add column if not exists mentioned_user_ids uuid[] not null default '{}';

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  actor_id uuid references profiles(id) on delete set null,
  invoice_id uuid references invoices(id) on delete cascade,
  comment_id uuid references invoice_comments(id) on delete cascade,
  type text not null default 'mention' check (type in ('mention')),
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_unread_idx
  on notifications (user_id, read, created_at desc);

alter table notifications enable row level security;

drop policy if exists "notifications: users can read their own" on notifications;
create policy "notifications: users can read their own" on notifications
  for select using (user_id = auth.uid());

drop policy if exists "notifications: members can insert" on notifications;
create policy "notifications: members can insert" on notifications
  for insert with check (is_org_member(organization_id));

drop policy if exists "notifications: users can update their own" on notifications;
create policy "notifications: users can update their own" on notifications
  for update using (user_id = auth.uid());

--------------------------------------------------------------------
-- >>> supabase/migrations/0027_conditional_step_approvers.sql
--------------------------------------------------------------------
-- Approval Flow: replace "one approver per step" with ApprovalMax-style
-- conditional routing — a step can have several approvers, each matched
-- by their own Class/Customer/Supplier condition, plus an optional
-- Default Approver used when nobody's condition matches. This is what
-- lets ONE workflow cover every project instead of needing a separate
-- workflow per project/customer (the actual problem being solved here —
-- see the "175 projects" conversation this migration comes out of).
--
-- Visibility changes to match: instead of "any approver on a workflow
-- linked to this invoice's project can see it" (approval_workflow_projects),
-- it's now "you can see this invoice if one of your own conditions
-- actually matches it (or you're a default approver on the workflow)" —
-- see is_eligible_approver() below. approval_workflow_projects is no
-- longer needed and is dropped.
--
-- Authored by Araza. Idempotent — safe to re-run.

-- ---------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------

alter table approval_workflow_steps add column if not exists name text not null default '';
alter table approval_workflow_steps add column if not exists approval_mode text not null default 'all'
  check (approval_mode in ('any', 'all'));
comment on column approval_workflow_steps.approval_mode is
  'When more than one approver''s condition matches the same invoice at this step: ''all'' requires every matching approver to approve; ''any'' completes the step on the first approval.';

create table if not exists approval_workflow_step_approvers (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references approval_workflow_steps(id) on delete cascade,
  approver_user_id uuid not null references profiles(id) on delete cascade,
  -- Fallback approver for this step, used only when no conditional
  -- approver's rules match the invoice. Not itself conditional.
  is_default boolean not null default false,
  row_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (step_id, approver_user_id)
);

create index if not exists approval_workflow_step_approvers_step_idx
  on approval_workflow_step_approvers (step_id);

create table if not exists approval_workflow_step_conditions (
  id uuid primary key default gen_random_uuid(),
  step_approver_id uuid not null references approval_workflow_step_approvers(id) on delete cascade,
  field text not null check (field in ('class', 'customer', 'supplier')),
  -- 'matches' = this approver is eligible only when the invoice's value(s)
  -- overlap match_values; 'not_matches' = eligible only when they don't.
  operator text not null check (operator in ('matches', 'not_matches')),
  -- Free text for class/supplier; project ids (as text) for customer.
  -- Multiple values = OR within this one condition row. Named
  -- match_values (not "values") since VALUES is a reserved SQL keyword.
  match_values text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists approval_workflow_step_conditions_approver_idx
  on approval_workflow_step_conditions (step_approver_id);

-- Preserve any existing single-approver assignment as that step's default
-- approver before dropping the old column — costs nothing and avoids
-- silently orphaning a real assignment, even though a clean rebuild of
-- the one real workflow is the plan going forward. Guarded on the column
-- still existing so this stays safe to re-run even after a prior run
-- already dropped it (a plain `insert ... select approver_user_id from
-- approval_workflow_steps` would otherwise fail with "column does not
-- exist" on a second run).
do $migrate_old_approvers$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'approval_workflow_steps' and column_name = 'approver_user_id'
  ) then
    insert into approval_workflow_step_approvers (step_id, approver_user_id, is_default)
    select id, approver_user_id, true
    from approval_workflow_steps
    where approver_user_id is not null
    on conflict (step_id, approver_user_id) do nothing;
  end if;
end
$migrate_old_approvers$;

-- Column is dropped further down, after the invoices policies that
-- currently reference it (directly, via ws.approver_user_id) are replaced
-- with versions that don't — Postgres tracks column dependencies through
-- RLS policy expressions, so dropping it first errors with "cannot drop
-- column ... other objects depend on it".

-- ---------------------------------------------------------------------
-- RLS: new tables (members read, admins manage — same pattern as
-- approval_workflow_rules in 0009_workflow_rules.sql)
-- ---------------------------------------------------------------------

alter table approval_workflow_step_approvers enable row level security;

drop policy if exists "step_approvers: members can read" on approval_workflow_step_approvers;
create policy "step_approvers: members can read" on approval_workflow_step_approvers
  for select using (
    exists (
      select 1 from approval_workflow_steps s
      join approval_workflows w on w.id = s.workflow_id
      where s.id = step_id and is_org_member(w.organization_id)
    )
  );

drop policy if exists "step_approvers: admins manage" on approval_workflow_step_approvers;
create policy "step_approvers: admins manage" on approval_workflow_step_approvers
  for all
  using (
    exists (
      select 1 from approval_workflow_steps s
      join approval_workflows w on w.id = s.workflow_id
      where s.id = step_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflow_steps s
      join approval_workflows w on w.id = s.workflow_id
      where s.id = step_id and is_org_admin(w.organization_id)
    )
  );

alter table approval_workflow_step_conditions enable row level security;

drop policy if exists "step_conditions: members can read" on approval_workflow_step_conditions;
create policy "step_conditions: members can read" on approval_workflow_step_conditions
  for select using (
    exists (
      select 1 from approval_workflow_step_approvers sa
      join approval_workflow_steps s on s.id = sa.step_id
      join approval_workflows w on w.id = s.workflow_id
      where sa.id = step_approver_id and is_org_member(w.organization_id)
    )
  );

drop policy if exists "step_conditions: admins manage" on approval_workflow_step_conditions;
create policy "step_conditions: admins manage" on approval_workflow_step_conditions
  for all
  using (
    exists (
      select 1 from approval_workflow_step_approvers sa
      join approval_workflow_steps s on s.id = sa.step_id
      join approval_workflows w on w.id = s.workflow_id
      where sa.id = step_approver_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflow_step_approvers sa
      join approval_workflow_steps s on s.id = sa.step_id
      join approval_workflows w on w.id = s.workflow_id
      where sa.id = step_approver_id and is_org_admin(w.organization_id)
    )
  );

-- ---------------------------------------------------------------------
-- Visibility: is a given user an eligible approver anywhere on this
-- invoice's workflow — i.e. would they end up as the effective approver
-- of some step, given the invoice's actual class/customer(project)/
-- supplier data? Forward-looking (checks every step, not just the
-- current one) so an approver on a later step can already see the
-- invoice, matching the old project-linked behavior. Default approvers
-- can always see the workflow's invoices (they're the catch-all for
-- whichever step they're on).
-- ---------------------------------------------------------------------

create or replace function is_eligible_approver(p_invoice_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_workflow_id uuid;
  v_vendor text;
  v_classes text[];
  v_project_ids text[];
  r_approver record;
  r_cond record;
  v_cond_values text[];
  approver_ok boolean;
begin
  select workflow_id, lower(trim(coalesce(vendor_name, '')))
    into v_workflow_id, v_vendor
    from invoices where id = p_invoice_id;

  if v_workflow_id is null then
    return false;
  end if;

  select coalesce(array_agg(distinct lower(trim(class))) filter (where class is not null and trim(class) <> ''), '{}')
    into v_classes
    from invoice_line_items where invoice_id = p_invoice_id;

  select coalesce(array_agg(distinct project_id::text) filter (where project_id is not null), '{}')
    into v_project_ids
    from invoice_line_items where invoice_id = p_invoice_id;
  if coalesce(array_length(v_project_ids, 1), 0) = 0 then
    select case when project_id is not null then array[project_id::text] else '{}'::text[] end
      into v_project_ids
      from invoices where id = p_invoice_id;
  end if;

  for r_approver in
    select sa.id, sa.is_default
    from approval_workflow_step_approvers sa
    join approval_workflow_steps s on s.id = sa.step_id
    where s.workflow_id = v_workflow_id
      and sa.approver_user_id = p_user_id
  loop
    if r_approver.is_default then
      return true;
    end if;

    approver_ok := true;
    for r_cond in
      select field, operator, match_values
      from approval_workflow_step_conditions
      where step_approver_id = r_approver.id
    loop
      select array_agg(lower(trim(x))) into v_cond_values from unnest(r_cond.match_values) x;
      v_cond_values := coalesce(v_cond_values, '{}');

      if r_cond.field = 'supplier' then
        if r_cond.operator = 'matches' and not (v_vendor = any(v_cond_values)) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_vendor = any(v_cond_values)) then
          approver_ok := false;
        end if;
      elsif r_cond.field = 'class' then
        if r_cond.operator = 'matches' and not (v_classes && v_cond_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_classes && v_cond_values) then
          approver_ok := false;
        end if;
      elsif r_cond.field = 'customer' then
        -- customer values are project ids (uuids as text) — no case
        -- folding, compare against r_cond.match_values directly.
        if r_cond.operator = 'matches' and not (v_project_ids && r_cond.match_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_project_ids && r_cond.match_values) then
          approver_ok := false;
        end if;
      end if;

      exit when approver_ok = false;
    end loop;

    if approver_ok then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

-- ---------------------------------------------------------------------
-- can_see_invoice(): swap the approval_workflow_projects join for
-- is_eligible_approver(). Used directly by invoice_approvals/
-- invoice_comments/invoice_documents/invoice_line_items/audit_log's own
-- policies (0008_workflow_access.sql), so redefining it here is enough
-- to update visibility everywhere those tables are concerned.
-- ---------------------------------------------------------------------

create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or is_eligible_approver(i.id, auth.uid())
          )
        )
      )
  );
$$;

-- invoices' own SELECT/UPDATE policies inline this same logic instead of
-- calling can_see_invoice() — a self-referential subquery inside
-- can_see_invoice() breaks INSERT ... RETURNING (see 0021's comment for
-- the full explanation). Redefine them the same way, just swapping in
-- is_eligible_approver().
drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (
    is_org_admin(organization_id)
    or is_org_auditor(organization_id)
    or (
      is_org_member(organization_id)
      and status <> 'on_review'
      and (
        project_id is null
        or submitted_by = auth.uid()
        or is_eligible_approver(id, auth.uid())
      )
    )
  );

drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (
    (
      is_org_admin(organization_id)
      or is_org_auditor(organization_id)
      or (
        is_org_member(organization_id)
        and status <> 'on_review'
        and (
          project_id is null
          or submitted_by = auth.uid()
          or is_eligible_approver(id, auth.uid())
        )
      )
    )
    and not is_org_auditor(organization_id)
  );

-- Now safe to drop — the policies above were the last things referencing it.
alter table approval_workflow_steps drop column if exists approver_user_id;

-- ---------------------------------------------------------------------
-- approval_workflow_projects is no longer used for anything — visibility
-- is condition-based now, not project-link-based. Dropping the table also
-- drops its own policies automatically, so there's nothing to do first —
-- an explicit `drop policy ... on approval_workflow_projects` would fail
-- on a second run once the table itself is already gone (unlike `drop
-- policy if exists`, `if exists` only guards the policy name, not the
-- table it's on).
-- ---------------------------------------------------------------------

drop table if exists approval_workflow_projects;

--------------------------------------------------------------------
-- >>> supabase/migrations/0028_category_condition.sql
--------------------------------------------------------------------
-- Adds "Category" as a fourth condition field for step approvers, alongside
-- Class/Supplier/Customer (0027) — matches invoice_line_items.category the
-- same way Class matches invoice_line_items.class. Authored by Araza.
-- Idempotent — safe to re-run.

alter table approval_workflow_step_conditions
  drop constraint if exists approval_workflow_step_conditions_field_check;
alter table approval_workflow_step_conditions
  add constraint approval_workflow_step_conditions_field_check
  check (field in ('class', 'customer', 'supplier', 'category'));

create or replace function is_eligible_approver(p_invoice_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_workflow_id uuid;
  v_vendor text;
  v_classes text[];
  v_categories text[];
  v_project_ids text[];
  r_approver record;
  r_cond record;
  v_cond_values text[];
  approver_ok boolean;
begin
  select workflow_id, lower(trim(coalesce(vendor_name, '')))
    into v_workflow_id, v_vendor
    from invoices where id = p_invoice_id;

  if v_workflow_id is null then
    return false;
  end if;

  select coalesce(array_agg(distinct lower(trim(class))) filter (where class is not null and trim(class) <> ''), '{}')
    into v_classes
    from invoice_line_items where invoice_id = p_invoice_id;

  select coalesce(array_agg(distinct lower(trim(category))) filter (where category is not null and trim(category) <> ''), '{}')
    into v_categories
    from invoice_line_items where invoice_id = p_invoice_id;

  select coalesce(array_agg(distinct project_id::text) filter (where project_id is not null), '{}')
    into v_project_ids
    from invoice_line_items where invoice_id = p_invoice_id;
  if coalesce(array_length(v_project_ids, 1), 0) = 0 then
    select case when project_id is not null then array[project_id::text] else '{}'::text[] end
      into v_project_ids
      from invoices where id = p_invoice_id;
  end if;

  for r_approver in
    select sa.id, sa.is_default
    from approval_workflow_step_approvers sa
    join approval_workflow_steps s on s.id = sa.step_id
    where s.workflow_id = v_workflow_id
      and sa.approver_user_id = p_user_id
  loop
    if r_approver.is_default then
      return true;
    end if;

    approver_ok := true;
    for r_cond in
      select field, operator, match_values
      from approval_workflow_step_conditions
      where step_approver_id = r_approver.id
    loop
      select array_agg(lower(trim(x))) into v_cond_values from unnest(r_cond.match_values) x;
      v_cond_values := coalesce(v_cond_values, '{}');

      if r_cond.field = 'supplier' then
        if r_cond.operator = 'matches' and not (v_vendor = any(v_cond_values)) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_vendor = any(v_cond_values)) then
          approver_ok := false;
        end if;
      elsif r_cond.field = 'class' then
        if r_cond.operator = 'matches' and not (v_classes && v_cond_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_classes && v_cond_values) then
          approver_ok := false;
        end if;
      elsif r_cond.field = 'category' then
        if r_cond.operator = 'matches' and not (v_categories && v_cond_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_categories && v_cond_values) then
          approver_ok := false;
        end if;
      elsif r_cond.field = 'customer' then
        -- customer values are project ids (uuids as text) — no case
        -- folding, compare against r_cond.match_values directly.
        if r_cond.operator = 'matches' and not (v_project_ids && r_cond.match_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_project_ids && r_cond.match_values) then
          approver_ok := false;
        end if;
      end if;

      exit when approver_ok = false;
    end loop;

    if approver_ok then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

--------------------------------------------------------------------
-- >>> supabase/migrations/0029_workflow_change_impact.sql
--------------------------------------------------------------------
-- Approval Flow: workflow change impact reports.
--
-- Unlike ApprovalMax, this app doesn't snapshot a workflow onto a bill
-- when it enters approval — effectiveApproversForStep()/is_eligible_approver()
-- are recomputed live from the current workflow definition every time. That
-- means editing a step's approvers/conditions takes effect on every
-- in-flight invoice (on_approval/on_hold) at that step IMMEDIATELY, with no
-- "restart the workflow" step to skip or forget — but also with no warning
-- if the edit strands a bill (its previously-eligible approver no longer
-- matches, and there's no default approver to fall back to).
--
-- Rather than gate saves behind a restart-style prompt, we report the
-- blast radius right after a save: src/app/workflows/page.tsx computes
-- which in-flight invoices at the edited step had their required-approver
-- set change (before vs. after the edit) and, if any did, writes one row
-- here. The Workflows page shows the most recent undismissed row as a
-- banner listing exactly which invoices were affected.
--
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists workflow_change_impacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null references approval_workflows(id) on delete cascade,
  step_id uuid references approval_workflow_steps(id) on delete set null,
  actor_id uuid references profiles(id) on delete set null,
  summary text not null,
  -- Array of { invoice_id, invoice_label, before: string[] (approver
  -- names), after: string[] } — resolved to display names at write time
  -- since the affected invoices/approvers can themselves change later.
  affected jsonb not null default '[]',
  created_at timestamptz not null default now(),
  dismissed_at timestamptz
);

create index if not exists workflow_change_impacts_org_idx
  on workflow_change_impacts (organization_id, dismissed_at, created_at desc);

alter table workflow_change_impacts enable row level security;

drop policy if exists "workflow_change_impacts: admins manage" on workflow_change_impacts;
create policy "workflow_change_impacts: admins manage" on workflow_change_impacts
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0030_auditor_cannot_create_invoices.sql
--------------------------------------------------------------------
-- Approval Flow: close a real read-only gap for the auditor role.
--
-- Every other write path (invoices UPDATE, line items, comments, documents,
-- decisions, projects, workflows) was already gated with
-- `and not is_org_auditor(organization_id)` back in migration 0014 — except
-- this one. "invoices: members can insert" (0001) only ever checked
-- is_org_member(), which is true for admin/auditor/user alike, so an
-- auditor could create a brand new invoice via manual upload
-- (POST /api/invoices/upload, which runs on the signed-in user's own RLS-
-- bound session, not a service-role client) despite the role being
-- documented everywhere else as fully read-only. Confirmed live: logged in
-- as an auditor, "+ Add invoice" was reachable and worked.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "invoices: members can insert" on invoices;
create policy "invoices: members can insert" on invoices
  for insert with check (
    is_org_member(organization_id) and not is_org_auditor(organization_id)
  );

-- Same gap, lower stakes: these two are only ever hit today as a side
-- effect of an already-gated primary action (audit_log after a decision,
-- notifications after a comment), so an auditor can't actually reach them
-- through the app's own UI — but closing them anyway keeps "read-only"
-- true at the RLS layer itself, not just "true for the paths we thought
-- to check."
drop policy if exists "audit_log: members can insert" on audit_log;
create policy "audit_log: members can insert" on audit_log
  for insert with check (
    is_org_member(organization_id) and not is_org_auditor(organization_id)
  );

drop policy if exists "notifications: members can insert" on notifications;
create policy "notifications: members can insert" on notifications
  for insert with check (
    is_org_member(organization_id) and not is_org_auditor(organization_id)
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0031_normalize_vendor_matching.sql
--------------------------------------------------------------------
-- Approval Flow: stronger vendor normalization for supplier matching and
-- duplicate detection.
--
-- Previously vendor_name_normalized was lower(trim(vendor_name)), which
-- treats "ONYX•FIRE PROTECTION SERVICES INC." and "ONYX FIRE PROTECTION
-- SERVICES INC." as DIFFERENT vendors — so a duplicate invoice (same
-- number, same amount, vendor differing only by a bullet/space) was not
-- flagged, and a supplier rule saved for one spelling didn't match the
-- other. The app-side duplicate key + supplier lookups now use the same
-- normalization (src/lib/matching.ts: lowercase, collapse any run of
-- non-alphanumerics to a single space, trim).
--
-- This migration rewrites the generated column to the matching expression
-- and, before that, dedupes any supplier_defaults rows that collide under
-- the new key (keeps the oldest).
--
-- NOTE: Postgres has no "ALTER COLUMN ... ADD GENERATED AS (...)" — a
-- generated column's expression can only be set at CREATE/ADD COLUMN, so
-- the column is dropped and re-created (its unique constraint goes with it
-- and is re-added). The guard checks the live expression first, so
-- re-running is a no-op once the strong expression is in place.
--
-- Authored by Araza. Idempotent — safe to re-run.

-- Dedupe rows that collide under the new normalization (keep the oldest).
delete from supplier_defaults a
using supplier_defaults b
where a.organization_id = b.organization_id
  and a.id > b.id
  and regexp_replace(lower(trim(a.vendor_name)), '[^a-z0-9]+', ' ', 'g')
    = regexp_replace(lower(trim(b.vendor_name)), '[^a-z0-9]+', ' ', 'g');

-- Rebuild the generated column with the stronger expression, unless it is
-- already the strong one.
do $$
begin
  if not exists (
    select 1
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where a.attrelid = 'supplier_defaults'::regclass
      and a.attname = 'vendor_name_normalized'
      and pg_get_expr(d.adbin, d.adrelid) like '%regexp_replace%'
  ) then
    alter table supplier_defaults drop column vendor_name_normalized;
    alter table supplier_defaults add column vendor_name_normalized text
      generated always as (
        regexp_replace(lower(trim(vendor_name)), '[^a-z0-9]+', ' ', 'g')
      ) stored;
    alter table supplier_defaults
      add constraint supplier_defaults_org_vendor_name_unique
      unique (organization_id, vendor_name_normalized);
  end if;
end $$;

--------------------------------------------------------------------
-- >>> supabase/migrations/0032_qbo.sql
--------------------------------------------------------------------
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

drop policy if exists "qbo_connections: admins only" on qbo_connections;
create policy "qbo_connections: admins only" on qbo_connections
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

alter table invoices add column if not exists qbo_bill_id text;
alter table invoices add column if not exists qbo_sync_status text
  check (qbo_sync_status in ('pending', 'synced', 'error'));
alter table invoices add column if not exists qbo_synced_at timestamptz;
alter table invoices add column if not exists qbo_error text;

--------------------------------------------------------------------
-- >>> supabase/migrations/0033_instructions_thread.sql
--------------------------------------------------------------------
-- Approval Flow: accounting instructions become an append-only thread.
--
-- Each approver/reviewer ADDS their own instruction line; nobody can edit
-- or delete a previous line (no UPDATE/DELETE policies — enforced at the
-- DB level). The whole thread becomes the QBO bill memo (PrivateNote) on
-- sync, so QBO Excel reports show every approver's note in order.
--
--   PM:      "Bill to the customer."
--   Manager: "Add 5% profit on the billing."
--   -> memo: "PM Name: Bill to the customer.\nManager Name: Add 5% profit..."
--
-- The old single accounting_instructions column is migrated into the
-- thread (kept on the row for reference; sync now reads the thread).
-- Authored by Araza. Idempotent — safe to re-run.

create table if not exists accounting_instructions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists accounting_instructions_invoice_idx
  on accounting_instructions (invoice_id, created_at);

alter table accounting_instructions enable row level security;

drop policy if exists "accounting_instructions: members can read" on accounting_instructions;
create policy "accounting_instructions: members can read" on accounting_instructions
  for select using (can_see_invoice(invoice_id));

drop policy if exists "accounting_instructions: members can insert" on accounting_instructions;
create policy "accounting_instructions: members can insert" on accounting_instructions
  for insert with check (
    can_see_invoice(invoice_id)
    and not is_org_auditor((select organization_id from invoices where id = invoice_id))
  );

-- Deliberately NO update/delete policies: the thread is append-only.

-- Migrate existing single-field instructions into the thread.
insert into accounting_instructions (invoice_id, author_id, body)
select id, submitted_by, accounting_instructions
from invoices
where accounting_instructions is not null and trim(accounting_instructions) <> '';


--------------------------------------------------------------------
-- >>> supabase/migrations/0034_qbo_categories.sql
--------------------------------------------------------------------
-- 0034: QuickBooks categories (Chart of Accounts mirror).
-- READ-ONLY against QuickBooks: we pull the account list so the app can
-- offer categories without ever writing to QBO. No vendor data is fetched.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists qbo_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_account_id text not null, -- QBO Account Id
  name text not null,
  account_type text, -- e.g. Expense, Income, Bank, Accounts Payable
  account_sub_type text, -- e.g. OtherCurrentLiabilities, CashOnHand
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_account_id)
);

alter table qbo_categories enable row level security;

-- Org members (any role) can read the category list.
drop policy if exists "qbo_categories: org members read" on qbo_categories;
create policy "qbo_categories: org members read" on qbo_categories
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_categories: admins manage" on qbo_categories;
create policy "qbo_categories: admins manage" on qbo_categories
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0035_qbo_tax_rates.sql
--------------------------------------------------------------------
-- 0035: QuickBooks tax RATES + CODES (the % and the letter codes used on
-- bills — e.g. "H" = HST 13%, "G" = GST 5%).
-- HARD RULE: this app NEVER writes to QuickBooks. These tables are
-- read-only mirrors of QBO TaxRate/TaxCode entities so Flow can offer the
-- correct tax % and codes on bills. No vendor/customer/project/class/
-- category data is ever pulled or written.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists qbo_tax_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_tax_rate_id text not null, -- QBO TaxRate Id
  name text not null,
  rate_value numeric not null, -- e.g. 5 for 5%
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_tax_rate_id)
);

alter table qbo_tax_rates enable row level security;

-- Org members (any role) can read the tax rate list.
drop policy if exists "qbo_tax_rates: org members read" on qbo_tax_rates;
create policy "qbo_tax_rates: org members read" on qbo_tax_rates
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_tax_rates: admins manage" on qbo_tax_rates;
create policy "qbo_tax_rates: admins manage" on qbo_tax_rates
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));

create table if not exists qbo_tax_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  qbo_tax_code_id text not null, -- QBO TaxCode Id
  name text not null, -- e.g. "H", "G", "P", "E", "Z", "M"
  description text,
  synced_at timestamptz not null default now(),
  unique (organization_id, qbo_tax_code_id)
);

alter table qbo_tax_codes enable row level security;

-- Org members (any role) can read the tax code list.
drop policy if exists "qbo_tax_codes: org members read" on qbo_tax_codes;
create policy "qbo_tax_codes: org members read" on qbo_tax_codes
  for select using (is_org_member(organization_id));

-- Admins manage the mirror (insert/update/delete happen on sync).
drop policy if exists "qbo_tax_codes: admins manage" on qbo_tax_codes;
create policy "qbo_tax_codes: admins manage" on qbo_tax_codes
  for all using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0036_qbo_classes.sql
--------------------------------------------------------------------
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

--------------------------------------------------------------------
-- >>> supabase/migrations/0037_qbo_suppliers.sql
--------------------------------------------------------------------
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

--------------------------------------------------------------------
-- >>> supabase/migrations/0038_qbo_category_acct_num.sql
--------------------------------------------------------------------
-- 0038: store the QBO account number on categories so they display and
-- resolve as "5-15450 - HVAC" (AcctNum + name), and sync back to QBO by
-- account number. Read-only mirror — nothing is ever written to QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_categories add column if not exists acct_num text;

--------------------------------------------------------------------
-- >>> supabase/migrations/0039_qbo_ready_status.sql
--------------------------------------------------------------------
-- 0039: add the 'qbo_ready' status — the admin-only final gate.
--
-- When a bill completes EVERY step of its approval workflow it lands in
-- 'qbo_ready' (not 'approved'). It sits there until an admin presses the
-- final "Sync to QuickBooks" button, which is the only thing that sends
-- the bill to QBO. This enforces the hard rule: no bill reaches QBO until
-- the full workflow is done AND an admin explicitly releases it.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices drop constraint if exists invoices_status_check;

-- Fully-approved invoices that were never synced to QBO become 'qbo_ready'
-- (they need the admin's final release). Ones already synced stay 'approved'.
update invoices set status = 'qbo_ready'
where status = 'approved' and coalesce(qbo_sync_status, '') <> 'synced';

alter table invoices add constraint invoices_status_check
  check (status in ('on_review', 'on_approval', 'qbo_ready', 'approved', 'cancelled', 'rejected', 'on_hold'));

--------------------------------------------------------------------
-- >>> supabase/migrations/0040_qbo_tax_code_rate.sql
--------------------------------------------------------------------
-- 0040: store the resolved purchase-side rate on tax codes so the bill's
-- Tax field can offer the QBO codes ("H" → 13%) exactly like Dext/
-- ApprovalMax. Read-only mirror — nothing is ever written to QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_tax_codes add column if not exists rate_value numeric;

--------------------------------------------------------------------
-- >>> supabase/migrations/0041_qbo_vendor_matched.sql
--------------------------------------------------------------------
-- 0041: flag invoices whose OCR'd vendor did NOT exactly match a QBO
-- supplier. Such bills are visibly marked and cannot sync to QBO until a
-- human picks the correct supplier (exact match). This makes vendor
-- mismatches visible upfront instead of at push time.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices add column if not exists qbo_vendor_matched boolean
  not null default true;

--------------------------------------------------------------------
-- >>> supabase/migrations/0042_cos_extras_flag.sql
--------------------------------------------------------------------
-- 0042: persist the CO/Extras flag on the invoice.
--
-- Flow: the reviewer (accountant) clears review without seeing this — it is
-- the NEXT approver (usually the project manager) who decides whether the
-- bill has COs/Extras. Once they tick the box and approve, the flag is
-- LOCKED: nobody downstream can remove it, and the line items are classed
-- "Extras" (a real QBO class) at that point.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices add column if not exists has_cos_or_extras boolean
  not null default false;

--------------------------------------------------------------------
-- >>> supabase/migrations/0043_qbo_tax_liability_account.sql
--------------------------------------------------------------------
-- 0043: let each org configure its own QBO Sales Tax Liability Account,
-- instead of Flow guessing a hardcoded account name ("Sales Tax Payable")
-- that not every company's Chart of Accounts actually has.
--
-- Lives on qbo_connections because it's a per-realm/per-company setting,
-- same as company_name and realm_id — one row per org, admin-only RLS
-- already in place. Flow never creates this account; an admin must pick
-- an existing, active liability account from the synced Chart of Accounts.
-- Only the id is stored — the display name is resolved from qbo_categories
-- (the existing Chart of Accounts mirror) so it can never go stale if the
-- account is renamed in QBO.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_connections add column if not exists tax_liability_account_id text;

--------------------------------------------------------------------
-- >>> supabase/migrations/0044_qbo_drop_tax_liability_account.sql
--------------------------------------------------------------------
-- 0044: undo 0043. Testing showed a per-org "Sales Tax Liability Account"
-- was the wrong approach -- QBO already calculates and posts sales tax
-- itself once a bill line carries a native TaxCodeRef; Flow manually
-- posting a "Tax" line to a configured account double-handled tax and
-- posted to the wrong kind of account (a liability for tax the business
-- COLLECTS on sales, not tax it PAYS to a vendor on a bill). Sales tax is
-- now represented via TaxCodeRef, resolved from the existing qbo_tax_codes
-- mirror (see resolveTaxCode/matchTaxCode in src/lib/qbo.ts) -- no
-- per-org account configuration needed at all.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_connections drop column if exists tax_liability_account_id;

--------------------------------------------------------------------
-- >>> supabase/migrations/0045_line_item_qbo_tax_code.sql
--------------------------------------------------------------------
-- 0045: store which specific QBO tax CODE was selected on a line, not just
-- its resolved percentage. Two codes can share the same rate (this app has
-- seen "H" and "M&E (ON)" both resolve to 13%) -- tax_rate alone can't tell
-- them apart, so syncToQbo couldn't know which TaxCodeRef to send without
-- guessing. The Tax field now submits the exact QBO tax code id; tax_rate
-- is kept alongside it (still needed for the app's own tax-total math and
-- display) but is no longer the only record of what was picked.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoice_line_items add column if not exists qbo_tax_code_id text;

--------------------------------------------------------------------
-- >>> supabase/migrations/0046_supplier_settings.sql
--------------------------------------------------------------------
-- 0046: back the new Settings -> Suppliers page.
--
-- product_service: a free-text default (no QBO "Item"/ProductService
-- mirror exists in this app yet, so this is just a stored label, not
-- matched against anything or sent to QBO on sync).
--
-- integration: which accounting platform this supplier belongs to.
-- Every supplier today comes from the one QBO connection this org has
-- (qbo_suppliers is otherwise a read-only mirror -- see 0037), but the
-- Suppliers page lets an admin flag Xero/Zoho Books for when those
-- connections exist. Purely informational until then; nothing reads it
-- yet. Defaults every existing + future row to quickbooks_online since
-- that's the only real connection this app supports today.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table supplier_defaults add column if not exists product_service text;

alter table qbo_suppliers add column if not exists integration text not null default 'quickbooks_online';

--------------------------------------------------------------------
-- >>> supabase/migrations/0047_fix_supplier_name_normalization.sql
--------------------------------------------------------------------
-- 0047: fix a real matching bug found while bulk-seeding supplier
-- defaults. supplier_defaults.vendor_name_normalized (a generated column,
-- 0020/0031) computes trim(lower(vendor_name)) THEN collapses runs of
-- non-alphanumeric characters to a single space -- but never trims again
-- afterward. Any vendor name ending in punctuation (e.g. "Marsil
-- Mechanical Inc.") collapses its trailing period into a trailing SPACE,
-- e.g. "marsil mechanical inc ". normalizeForMatching() in
-- src/lib/matching.ts (used everywhere else this app matches vendor
-- names, including at invoice ingestion) trims AFTER the collapse and
-- produces "marsil mechanical inc" -- no trailing space. The two never
-- matched for any such vendor, so a saved supplier rule for a name ending
-- in punctuation was silently never applied at ingestion.
--
-- Postgres can't ALTER a stored generated column's expression in place,
-- so the column is dropped and re-added with an extra outer trim() to
-- match normalizeForMatching() exactly. Recomputes for all existing rows.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table supplier_defaults drop constraint if exists supplier_defaults_org_vendor_name_unique;
alter table supplier_defaults drop column if exists vendor_name_normalized;
alter table supplier_defaults add column vendor_name_normalized text generated always as (
  trim(regexp_replace(lower(trim(vendor_name)), '[^a-z0-9]+', ' ', 'g'))
) stored;
alter table supplier_defaults add constraint supplier_defaults_org_vendor_name_unique
  unique (organization_id, vendor_name_normalized);

--------------------------------------------------------------------
-- >>> supabase/migrations/0048_default_tax_and_totals_note.sql
--------------------------------------------------------------------
-- 0043: per-org default tax rate for new invoices, and a totals-discrepancy
-- note on invoices.
--
-- 1. organizations.default_tax_rate — the tax rate applied to every new
--    invoice when the supplier has no rule of their own. Set in Settings
--    (below the tax sync section); the value is one of the synced QBO tax
--    code rates (e.g. 13 for H 13%).
-- 2. invoices.totals_note — set at ingestion when the document's printed
--    total disagrees with the line-item derivation. The DOCUMENT total wins
--    ("matches at all costs"); this note tells the reviewer what happened.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists default_tax_rate numeric;

alter table invoices add column if not exists totals_note text;

--------------------------------------------------------------------
-- >>> supabase/migrations/0049_qbo_sync_log_and_first_seen.sql
--------------------------------------------------------------------
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

--------------------------------------------------------------------
-- >>> supabase/migrations/0050_organizations_admin_update.sql
--------------------------------------------------------------------
-- 0050: allow org ADMINS to UPDATE organizations (Settings).
--
-- The only in-app write to organizations is the default tax rate
-- (saveDefaultTaxRate). Members could already READ the row, but there was
-- NO update policy — RLS silently rejected the save (the action didn't check
-- the error either), so the rate never persisted and Settings kept showing
-- "No default set". This policy lets admins update the org row.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "organizations: admins can update" on organizations;
create policy "organizations: admins can update" on organizations
  for update using (is_org_admin(id)) with check (is_org_admin(id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0051_inbound_email_local.sql
--------------------------------------------------------------------
-- 0051: friendly per-org capture addresses on the shared inbound domain.
--
-- Clients email invoices to {companyname}@{INBOUND_EMAIL_DOMAIN} (e.g.
-- fluid@flow.ufirst.co) instead of a random token — the same model as
-- ApprovalMax/Dext: the address is on OUR domain, the client changes
-- nothing, and they log in at our app to manage invoices.
--
-- inbound_email_local — the friendly local part (lowercase letters, digits,
-- dash, underscore, dot; up to 64 chars). When set, BOTH the friendly local
-- part and the token still resolve to the org; when null, the token keeps
-- working exactly as before. Unique across tenants (one shared domain).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists inbound_email_local text;

alter table organizations add constraint organizations_inbound_email_local_format
  check (inbound_email_local is null
    or inbound_email_local ~ '^[a-z0-9][a-z0-9._-]{0,63}$');

create unique index if not exists organizations_inbound_email_local_unique
  on organizations (inbound_email_local) where inbound_email_local is not null;

--------------------------------------------------------------------
-- >>> supabase/migrations/0052_email_log_pending_splits.sql
--------------------------------------------------------------------
-- 0052: track which pending-split reviews an inbound email produced, so the
-- Email queue page can link "split review" emails straight to the review
-- instead of only counting them.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table inbound_email_log add column if not exists pending_split_ids uuid[] not null default '{}';

--------------------------------------------------------------------
-- >>> supabase/migrations/0053_email_log_admin_delete.sql
--------------------------------------------------------------------
-- 0053: admins can REMOVE entries from the inbound email queue (bad/spam
-- messages, tests, wrong recipients). Members can still read; only admins
-- can delete. Mirrors the read policy's organization_id-null guard.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "inbound_email_log: admins can delete" on inbound_email_log;
create policy "inbound_email_log: admins can delete" on inbound_email_log
  for delete using (
    organization_id is not null and is_org_admin(organization_id)
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0054_upload_log.sql
--------------------------------------------------------------------
-- 0054: upload_log — durable record of every manual upload, for the upload
-- queue's "Recent uploads" list and for future reporting on how extraction
-- (OCR) and the queue perform (success/fail rates, per-file processing
-- time via created_at → processed_at).
--
-- The upload route writes one row per file with the OUTCOME the server
-- actually produced (done → invoice, split → pending review, error →
-- reason). Old rows are cleaned up automatically (90-day retention, done
-- opportunistically by the upload route / email webhook), so the queue
-- never grows into thousands of rows (a busy client sends 350+/month).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists upload_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  filename text not null,
  file_type text,
  file_size_bytes bigint,
  status text not null check (status in ('done', 'split', 'error')),
  invoice_id uuid references invoices(id) on delete set null,
  pending_split_id uuid references pending_invoice_splits(id) on delete set null,
  error text,
  source text not null default 'manual' check (source in ('manual', 'email')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists upload_log_org_created_idx
  on upload_log (organization_id, created_at desc);

alter table upload_log enable row level security;

-- Org members (any role) can read the upload log.
drop policy if exists "upload_log: members can read" on upload_log;
create policy "upload_log: members can read" on upload_log
  for select using (is_org_member(organization_id));

-- Members can insert (the upload route runs as the signed-in user).
drop policy if exists "upload_log: members can insert" on upload_log;
create policy "upload_log: members can insert" on upload_log
  for insert with check (is_org_member(organization_id));

-- Admins can delete (manual cleanup).
drop policy if exists "upload_log: admins can delete" on upload_log;
create policy "upload_log: admins can delete" on upload_log
  for delete using (is_org_admin(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0055_ingest_jobs.sql
--------------------------------------------------------------------
-- 0055: async ingestion queue. Extraction (the 20-60s OpenRouter call) moves
-- OFF the request path: uploads/emails return instantly with a queued job,
-- and a background worker (the UI's /api/ingest/process poller) runs the
-- extraction + invoice creation. This removes the freeze-on-every-upload
-- and the Vercel Hobby one-function-at-a-time pileup.
--
-- 1. ingest_jobs — the worker queue. staging_path holds the file bytes the
--    route/webhook uploaded; the worker downloads them, runs the normal
--    ingest pipeline (ingestInvoiceFile → invoice/split), writes the
--    outcome to upload_log / inbound_email_log, and removes the staging
--    file. attempt_count + retry back to 'queued' on failure (< 3 tries).
-- 2. upload_log.status gains 'queued'/'processing' (the upload route
--    records the queued row immediately; the worker completes it).
-- 3. inbound_email_log.processing — set by the webhook at enqueue time so
--    the Queue page can show in-flight emails; cleared by the worker.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  staging_path text not null,
  file_name text not null,
  mime_type text,
  file_size_bytes bigint,
  source text not null check (source in ('manual', 'email')),
  submitted_by uuid references auth.users(id) on delete set null,
  source_email text,
  status text not null default 'queued' check (status in ('queued', 'processing', 'done', 'error')),
  attempt_count int not null default 0,
  last_error text,
  upload_log_id uuid references upload_log(id) on delete set null,
  inbound_email_log_id uuid references inbound_email_log(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists ingest_jobs_org_status_idx
  on ingest_jobs (organization_id, status, created_at);

alter table ingest_jobs enable row level security;

drop policy if exists "ingest_jobs: members can read" on ingest_jobs;
create policy "ingest_jobs: members can read" on ingest_jobs
  for select using (is_org_member(organization_id));

drop policy if exists "ingest_jobs: members can insert" on ingest_jobs;
create policy "ingest_jobs: members can insert" on ingest_jobs
  for insert with check (is_org_member(organization_id));

drop policy if exists "ingest_jobs: members can update" on ingest_jobs;
create policy "ingest_jobs: members can update" on ingest_jobs
  for update using (is_org_member(organization_id));

drop policy if exists "ingest_jobs: admins can delete" on ingest_jobs;
create policy "ingest_jobs: admins can delete" on ingest_jobs
  for delete using (is_org_admin(organization_id));

-- upload_log: the upload route inserts a queued row; the worker completes it.
alter table upload_log drop constraint if exists upload_log_status_check;
alter table upload_log add constraint upload_log_status_check
  check (status in ('queued', 'processing', 'done', 'split', 'error'));

drop policy if exists "upload_log: members can update" on upload_log;
create policy "upload_log: members can update" on upload_log
  for update using (is_org_member(organization_id));

-- inbound_email_log: in-flight marker + members update (the worker runs as
-- the signed-in user via the poller).
alter table inbound_email_log add column if not exists processing boolean not null default false;

drop policy if exists "inbound_email_log: members can update" on inbound_email_log;
create policy "inbound_email_log: members can update" on inbound_email_log
  for update using (
    organization_id is not null and is_org_member(organization_id)
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0056_storage_update_policy.sql
--------------------------------------------------------------------
-- 0056: storage UPDATE policy for the invoices bucket.
--
-- Reordering pages (Reorder pages…) replaces the stored PDF in place via an
-- upsert. storage.objects only had INSERT / SELECT / DELETE policies for
-- the invoices bucket, so the upsert failed with "new row violates
-- row-level security policy". This lets org members update their own
-- bucket files (same org-folder check as the insert policy).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "invoice files: members can update" on storage.objects;
create policy "invoice files: members can update" on storage.objects
  for update using (
    bucket_id = 'invoices'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0057_upload_log_no_invoice.sql
--------------------------------------------------------------------
-- 0057: upload_log gains a 'no_invoice' outcome — for documents that merge
-- into a PDF but yield NO invoice data at all (no number, no total, no line
-- items), the app does NOT create an invoice and marks the queue entry as
-- "No invoice data found" instead of a retryable failure. Blank/unnumbered
-- pages inside a real invoice are never affected (the guard looks at the
-- whole document, and only documents with literally no invoice data are
-- skipped).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table upload_log drop constraint if exists upload_log_status_check;
alter table upload_log add constraint upload_log_status_check
  check (status in ('queued', 'processing', 'done', 'split', 'error', 'no_invoice'));

--------------------------------------------------------------------
-- >>> supabase/migrations/0058_invoice_document_total.sql
--------------------------------------------------------------------
-- 0058: invoices.document_total — the invoice's PRINTED total, stored
-- separately so edits can re-run the "document total wins" reconciliation:
-- when line items are changed and now match the printed total, the amber
-- note clears; when they still disagree, the document total stays + the
-- note stays. Also backfills existing rows from the saved extraction JSON.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices add column if not exists document_total numeric;

update invoices set document_total = (extraction->>'total_amount')::numeric
  where document_total is null
    and extraction is not null
    and extraction->>'total_amount' is not null
    and (extraction->>'total_amount')::numeric is not null;

--------------------------------------------------------------------
-- >>> supabase/migrations/0059_default_tax_code.sql
--------------------------------------------------------------------
-- 0059: organizations.default_tax_code_id — the default tax for new invoices
-- stored as a specific QBO tax CODE (e.g. H 13%), not just a rate.
--
-- Why: H and "M&E (ON)" are both 13%, and the QBO sync refuses to guess
-- between duplicate-rate codes. Ingest applies the rate (13) but the lines
-- carry no code, so the sync can't pick H. Storing the CODE removes the
-- ambiguity: new lines get the exact code (H), and the sync posts it
-- directly.
--
-- Backfill: orgs that already have default_tax_rate get the synced code with
-- that rate, preferring a code literally named "H" (case-insensitive), then
-- alphabetical.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists default_tax_code_id text;

update organizations o
  set default_tax_code_id = (
    select c.qbo_tax_code_id
    from qbo_tax_codes c
    where c.organization_id = o.id
      and c.rate_value = o.default_tax_rate
    order by (lower(c.name) = 'h') desc, c.name asc
    limit 1
  )
  where o.default_tax_rate is not null
    and o.default_tax_code_id is null;

--------------------------------------------------------------------
-- >>> supabase/migrations/0060_email_log_skipped_attachments.sql
--------------------------------------------------------------------
-- Record attachments dropped from an inbound email so nothing silently
-- disappears: signature/logo images (never invoices) and non-PDF files
-- (spreadsheets etc.) that the app cannot process.
alter table public.inbound_email_log
  add column if not exists skipped_attachments jsonb;

--------------------------------------------------------------------
-- >>> supabase/migrations/0061_usage_events.sql
--------------------------------------------------------------------
-- Flow's own usage billing: track how many documents each client org has
-- processed, and the per-org rate (USD per document). The SaaS charges the
-- client per document processed — the invoice is sent manually (this is
-- tracking only, no payment processor). Recorded at the point a document
-- is ACCEPTED into the pipeline (webhook download / manual upload), never
-- at retry time, so one document always counts once.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_name text not null,
  source text not null default 'email',   -- 'email' | 'manual'
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

-- Members can read their own org's usage (the Billing page); inserts happen
-- server-side (webhook admin client, upload route member client).
drop policy if exists "usage_events: members can read" on usage_events;
create policy "usage_events: members can read" on usage_events
  for select using (is_org_member(organization_id));

drop policy if exists "usage_events: members can insert" on usage_events;
create policy "usage_events: members can insert" on usage_events
  for insert with check (is_org_member(organization_id));

create index if not exists usage_events_org_created_idx
  on usage_events (organization_id, created_at desc);

-- Per-org charge per document processed, in USD. Default 0.15.
alter table public.organizations
  add column if not exists usage_rate_usd numeric not null default 0.15;

--------------------------------------------------------------------
-- >>> supabase/migrations/0062_usage_rate_updated_at.sql
--------------------------------------------------------------------
-- Track when the org's per-document usage rate was last saved, so the
-- Billing page can show "0.15 — saved on <date>" and grey the Save button
-- until the value changes again.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table public.organizations
  add column if not exists usage_rate_updated_at timestamptz;

-- Existing rows: treat the current rate as "saved now" so the page has a
-- date to show (rather than a blank "never saved").
update public.organizations
  set usage_rate_updated_at = now()
  where usage_rate_updated_at is null
    and usage_rate_usd is not null;

--------------------------------------------------------------------
-- >>> supabase/migrations/0063_line_item_product_service.sql
--------------------------------------------------------------------
-- 0063: invoice_line_items.product_service — carries a supplier rule's
-- Product/Service default (supplier_defaults.product_service, free text,
-- no QBO Item mirror yet) onto each line at ingestion, the same way
-- category/class already do. Not yet sent to QBO on sync — that needs its
-- own QBO Item mirror + matcher (mirroring how Category/Class/Tax/Supplier
-- already work), since Flow never guesses/creates entities in QBO and a
-- QBO Bill's ItemBasedExpenseLineDetail is a different line shape than the
-- AccountBasedExpenseLineDetail this app always sends today.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoice_line_items add column if not exists product_service text;

--------------------------------------------------------------------
-- >>> supabase/migrations/0064_drop_product_service.sql
--------------------------------------------------------------------
-- 0064: drop product_service entirely. The feature (built out fully in
-- migrations 0046 and 0063, plus the corresponding app code) was reverted
-- on 2026-08-27 -- the org manages this through Category instead, and
-- never uses more than one accounting platform (QBO) to justify it.
-- Both columns were confirmed empty (no rows had a value) before dropping.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table supplier_defaults drop column if exists product_service;
alter table invoice_line_items drop column if exists product_service;

--------------------------------------------------------------------
-- >>> supabase/migrations/0065_drop_cos_extras.sql
--------------------------------------------------------------------
-- 0065: drop the CO/Extras flag entirely. This auto-stamp feature (added by
-- migration 0042) never actually worked -- its "stamp Extras on lines
-- without a class" filter used `.not("class", "in", '("Contract",
-- "Change Orders")')`, which under SQL three-valued logic never matches a
-- NULL class (the normal unset state), so it silently never fired for a
-- typical bill. It's also been fully superseded by the per-line CON/CO
-- toggle buttons on the line-item Class field, which tag each line
-- directly and correctly. Confirmed no invoice had the flag set to true
-- and no line item had class = 'Extras' before dropping -- nothing lost.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices drop column if exists has_cos_or_extras;

--------------------------------------------------------------------
-- >>> supabase/migrations/0066_ingest_job_force_split.sql
--------------------------------------------------------------------
-- 0066: ingest_jobs.force_split -- carries the [1N]/[NM] subject-code
-- "force split review" decision through to a queued job. Previously this
-- only applied when an attachment was processed inline in the email
-- webhook; a job that fell back to the queue (or, after the durability
-- fix that made EVERY attachment go through the queue, every job) never
-- got this flag at all -- silently dropping the force-split behavior for
-- that document. Read by runNextIngestJob and passed to ingestInvoiceFile.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table ingest_jobs add column if not exists force_split boolean not null default false;

--------------------------------------------------------------------
-- >>> supabase/migrations/0067_user_role_project_visibility.sql
--------------------------------------------------------------------
-- 0067: a plain "user" org member should only see invoices for the
-- projects they're actually assigned to (via workflow step approver
-- conditions — the same "Customer" condition that already drives approval
-- eligibility, reused here rather than building a second, separate
-- assignment concept) plus whatever they submitted themselves. Admins and
-- auditors are unaffected (both already bypass this branch entirely via
-- is_org_admin/is_org_auditor).
--
-- Previously `project_id is null` gave every member blanket visibility
-- into any invoice with no project set at all, regardless of eligibility
-- — dropped here so "cannot see anyone else's invoices" actually holds.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or is_org_auditor(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and (
            i.submitted_by = auth.uid()
            or is_eligible_approver(i.id, auth.uid())
          )
        )
      )
  );
$$;

drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (
    is_org_admin(organization_id)
    or is_org_auditor(organization_id)
    or (
      is_org_member(organization_id)
      and status <> 'on_review'
      and (
        submitted_by = auth.uid()
        or is_eligible_approver(id, auth.uid())
      )
    )
  );

drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (
    (
      is_org_admin(organization_id)
      or is_org_auditor(organization_id)
      or (
        is_org_member(organization_id)
        and status <> 'on_review'
        and (
          submitted_by = auth.uid()
          or is_eligible_approver(id, auth.uid())
        )
      )
    )
    and not is_org_auditor(organization_id)
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0068_invoice_approvals_admin_delete.sql
--------------------------------------------------------------------
-- 0068: invoice_approvals never had a DELETE policy at all (only
-- read/insert), so backToReview/overrideStatus/setInvoiceStage's resets of
-- old decisions (so a workflow can re-run cleanly) were silently deleting
-- ZERO rows through the RLS-bound client -- no error surfaced, since
-- Postgres/PostgREST doesn't treat "0 rows matched a policy" as a
-- failure. Symptom: force a rejected invoice back to on_approval / a
-- specific stage, and its stepper still shows the OLD rejected decision
-- (a red X) instead of pending, and decide()'s alreadyDecided check
-- treats the approver as having already voted.
--
-- The three call sites now also route the delete through the admin client
-- directly (defense in depth, since canReview() already confirmed the
-- caller), but this closes the actual gap the way `invoices` already
-- has its own "admins can delete" policy -- so any future admin action
-- that needs to clear decisions works correctly through the plain
-- RLS-bound client too, without having to remember the workaround.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "invoice_approvals: admins can delete" on invoice_approvals;
create policy "invoice_approvals: admins can delete" on invoice_approvals
  for delete using (
    exists (
      select 1 from invoices i
      where i.id = invoice_id and is_org_admin(i.organization_id)
    )
  );

--------------------------------------------------------------------
-- >>> supabase/migrations/0069_notifications_assigned_type.sql
--------------------------------------------------------------------
-- 0069: a second notifications.type, 'assigned' -- "it's your turn to
-- review this invoice" (sent whenever responsibility moves to a new
-- approver: entering the workflow, advancing to the next step, an admin
-- reassigning/setting a stage), alongside the existing 'mention' type.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('mention', 'assigned'));

--------------------------------------------------------------------
-- >>> supabase/migrations/0070_inbound_email_idempotency.sql
--------------------------------------------------------------------
-- 0070: inbound_email_log.email_id -- Resend's own id for the received
-- email, used to make the webhook idempotent against retried deliveries.
--
-- Root cause of a real, repeated incident: this webhook does real work
-- synchronously (list/download attachments, then run the ingest queue for
-- up to 35s) before ever returning a response. If Resend doesn't get a
-- fast reply, it retries delivery of the SAME email.received event -- and
-- the handler had no way to tell "I've already seen this exact delivery"
-- from "this is a brand new email". A retry created a second
-- inbound_email_log row and a second set of ingest_jobs for the SAME
-- attachments, producing duplicate invoices for the same email
-- (reported live, repeatedly, for the same supplier's invoices). This is
-- NOT the "possible duplicate" business case (a genuine resubmission/
-- amendment that must go through review) -- it's the literal same event
-- notification arriving twice, which should never be processed twice at
-- all.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table inbound_email_log add column if not exists email_id text;

create unique index if not exists inbound_email_log_email_id_unique
  on inbound_email_log (email_id) where email_id is not null;

--------------------------------------------------------------------
-- >>> supabase/migrations/0071_support_chat.sql
--------------------------------------------------------------------
-- 0071: a simple support chat -- one continuous thread per organization,
-- any member can read/post, so a customer can reach the platform owner
-- directly instead of email. Platform admins reach it the same way
-- regular members do: by being an actual organization_members row on
-- that org (already how admin-created orgs work -- see
-- createOrganizationAction/joinOrganizationAction), not a separate
-- cross-org bypass table.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists support_messages_org_idx
  on support_messages (organization_id, created_at);

alter table support_messages enable row level security;

drop policy if exists "support_messages: members can read" on support_messages;
create policy "support_messages: members can read" on support_messages
  for select using (is_org_member(organization_id));

drop policy if exists "support_messages: members can insert" on support_messages;
create policy "support_messages: members can insert" on support_messages
  for insert with check (is_org_member(organization_id));

--------------------------------------------------------------------
-- >>> supabase/migrations/0072_notifications_rejected_type.sql
--------------------------------------------------------------------
-- 0072: a third notifications.type, 'rejected' -- sent to the submitter
-- when their invoice is rejected. Previously nothing notified them at
-- all beyond a Discussion comment they'd only see if they happened to
-- reopen the invoice. Alongside the existing 'mention'/'assigned' types.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('mention', 'assigned', 'rejected'));
