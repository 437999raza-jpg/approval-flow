-- Which suppliers are subcontractors.
--
-- Holdback is not a property of a bill, it's a property of the
-- relationship: it applies to subcontractors working under a contract,
-- not to a counter purchase. Buying screws at Home Depot or renting a
-- container from Battlefield carries no holdback, and applying the
-- org's default rate to every supplier — which is what migration 0097
-- on its own would have done — would have withheld 10% from the wrong
-- half of the payables ledger.
--
-- So the flag gates the whole feature: no subcontractor flag, no
-- holdback, whatever the invoice says. That also makes detection safer,
-- since a materials invoice can no longer trigger anything on a stray
-- line description.
--
-- Defaults to false. Nothing is a subcontractor until someone says so,
-- because the failure that matters is withholding money from a supplier
-- who was never owed a holdback.
--
-- The same flag is what a T5018 (CRA Statement of Contract Payments)
-- would be built from, since that return covers exactly this set of
-- suppliers.
--
-- Authored by Araza.

alter table suppliers
  add column if not exists is_subcontractor boolean not null default false;

create index if not exists suppliers_subcontractor_idx
  on suppliers (organization_id)
  where is_subcontractor;

comment on column suppliers.is_subcontractor is
  'Works under a contract, so holdback/retainage applies. Materials and rental suppliers are false. Gates all retainage accrual (migration 0097) and is the population a T5018 would report.';
