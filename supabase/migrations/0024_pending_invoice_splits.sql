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
