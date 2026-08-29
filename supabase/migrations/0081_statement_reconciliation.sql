-- 0081: Statement Reconciliation (Detailed-plan feature, see 0080). One
-- upload of a vendor's statement produces a header row plus one row per
-- extracted line, matched against this org's existing invoices by vendor
-- + invoice number. Run via `supabase db push` or paste into the
-- Supabase SQL editor.

create table if not exists vendor_statements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_name text not null,
  file_path text not null,
  file_name text not null,
  uploaded_by uuid references profiles(id) on delete set null,
  status text not null default 'processing'
    check (status in ('processing', 'reconciled', 'error')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists vendor_statements_org_idx
  on vendor_statements (organization_id, created_at desc);

create table if not exists vendor_statement_lines (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references vendor_statements(id) on delete cascade,
  invoice_number text not null,
  statement_date date,
  amount numeric(14, 2),
  match_status text not null check (match_status in ('matched', 'missing_in_flow')),
  matched_invoice_id uuid references invoices(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists vendor_statement_lines_statement_idx
  on vendor_statement_lines (statement_id);

alter table vendor_statements enable row level security;
alter table vendor_statement_lines enable row level security;

drop policy if exists "vendor_statements: members can read" on vendor_statements;
create policy "vendor_statements: members can read" on vendor_statements
  for select using (is_org_member(organization_id));

drop policy if exists "vendor_statements: members can insert" on vendor_statements;
create policy "vendor_statements: members can insert" on vendor_statements
  for insert with check (is_org_member(organization_id));

drop policy if exists "vendor_statements: members can update" on vendor_statements;
create policy "vendor_statements: members can update" on vendor_statements
  for update using (is_org_member(organization_id));

-- Lines have no organization_id of their own — scope through the parent
-- statement, same way invoice_line_items scopes through invoices.
drop policy if exists "vendor_statement_lines: members can read" on vendor_statement_lines;
create policy "vendor_statement_lines: members can read" on vendor_statement_lines
  for select using (
    exists (
      select 1 from vendor_statements s
      where s.id = vendor_statement_lines.statement_id
        and is_org_member(s.organization_id)
    )
  );

drop policy if exists "vendor_statement_lines: members can insert" on vendor_statement_lines;
create policy "vendor_statement_lines: members can insert" on vendor_statement_lines
  for insert with check (
    exists (
      select 1 from vendor_statements s
      where s.id = vendor_statement_lines.statement_id
        and is_org_member(s.organization_id)
    )
  );

-- A third llm_usage_events.purpose value, for extracting statement lines
-- (same cost-tracking table as invoice extract/classify/search).
alter table llm_usage_events drop constraint if exists llm_usage_events_purpose_check;
alter table llm_usage_events add constraint llm_usage_events_purpose_check
  check (purpose in ('extract', 'classify', 'search', 'statement'));

-- ---------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------
-- Create a private "statements" bucket first (Storage > New bucket,
-- Public: off), or via SQL:
-- insert into storage.buckets (id, name, public) values ('statements', 'statements', false);
-- Same org-scoped-folder convention as the "invoices" bucket (0001_init.sql).

create policy "statement files: members can read"
  on storage.objects for select
  using (
    bucket_id = 'statements'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "statement files: members can upload"
  on storage.objects for insert
  with check (
    bucket_id = 'statements'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );
