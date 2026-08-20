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
