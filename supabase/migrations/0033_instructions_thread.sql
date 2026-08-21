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
