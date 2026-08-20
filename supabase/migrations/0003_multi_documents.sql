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
