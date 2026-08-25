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
