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
