-- Retainage accrues per LINE, not per invoice.
--
-- Migration 0097 assumed one holdback per bill. Real data says
-- otherwise: Senoz Electric invoice 4564 carries seven work lines, each
-- immediately followed by its own "10 % holdback" line — 14 lines, 7
-- pairs. Ridgeline 26-2422 has one pair. Both shapes are normal.
--
-- This matters beyond bookkeeping tidiness: invoice_line_items already
-- carries its own project_id, so two lines on one bill can belong to two
-- different jobs. Collapsing them to a single per-invoice accrual would
-- destroy exactly the job dimension this ledger exists to provide.
--
-- Safe to run as written: invoice_retainage has never held a row.
--
-- Authored by Araza.

alter table invoice_retainage
  add column if not exists line_item_id uuid
    references invoice_line_items(id) on delete cascade;

-- One accrual per holdback line, replacing one per invoice.
alter table invoice_retainage
  drop constraint if exists invoice_retainage_invoice_id_key;

drop index if exists invoice_retainage_line_unique;
create unique index invoice_retainage_line_unique
  on invoice_retainage (line_item_id)
  where line_item_id is not null;

create index if not exists invoice_retainage_invoice_idx
  on invoice_retainage (invoice_id);

comment on column invoice_retainage.line_item_id is
  'The holdback line this accrual came from. One accrual per line, because a bill can hold several — and because line items carry their own project_id, so two holdbacks on one invoice can belong to two different jobs.';
