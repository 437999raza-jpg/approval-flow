-- One-time backfill: link existing `suppliers` rows (migration 0092) to
-- their real QuickBooks vendor id, mirroring what resolveSupplier()
-- (src/lib/suppliers.ts) now does going forward whenever it resolves a
-- confirmed QBO match. Only fills a currently-null qbo_vendor_id — never
-- overwrites one already set. Exact normalized-name match only, and only
-- when exactly one qbo_suppliers row matches within the org (an ambiguous
-- name is left unlinked rather than guessed).
update suppliers s
set qbo_vendor_id = q.qbo_vendor_id
from qbo_suppliers q
where s.qbo_vendor_id is null
  and q.organization_id = s.organization_id
  and q.name_normalized = s.name_normalized
  and (
    select count(*) from qbo_suppliers q2
    where q2.organization_id = s.organization_id
      and q2.name_normalized = s.name_normalized
  ) = 1;
