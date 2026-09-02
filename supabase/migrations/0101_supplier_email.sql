-- A supplier email Flow owns.
--
-- qbo_suppliers.email (migration 0097) mirrors QuickBooks, and the next
-- supplier sync overwrites it with whatever QBO holds — which is null
-- for every one of Fluid's 2,049 vendors. So an address typed into Flow
-- had nowhere durable to live: it would survive until the next sync and
-- then quietly vanish.
--
-- This column is on Flow's own supplier entity, so it is never
-- overwritten by a sync. Reads prefer it and fall back to the QBO
-- mirror, which means typing an address once while sending a claim
-- request fixes it permanently, without anyone having to go and edit
-- the vendor record in QuickBooks first.
--
-- Authored by Araza.

alter table suppliers
  add column if not exists email text;

comment on column suppliers.email is
  'Contact address for this supplier, owned by Flow. Takes precedence over the qbo_suppliers mirror, which a sync overwrites. Set inline when requesting a holdback claim.';
