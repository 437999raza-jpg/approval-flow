-- Approval Flow: stronger vendor normalization for supplier matching and
-- duplicate detection.
--
-- Previously vendor_name_normalized was lower(trim(vendor_name)), which
-- treats "ONYX•FIRE PROTECTION SERVICES INC." and "ONYX FIRE PROTECTION
-- SERVICES INC." as DIFFERENT vendors — so a duplicate invoice (same
-- number, same amount, vendor differing only by a bullet/space) was not
-- flagged, and a supplier rule saved for one spelling didn't match the
-- other. The app-side duplicate key + supplier lookups now use the same
-- normalization (src/lib/matching.ts: lowercase, collapse any run of
-- non-alphanumerics to a single space, trim).
--
-- This migration rewrites the generated column to the matching expression
-- and, before that, dedupes any supplier_defaults rows that collide under
-- the new key (keeps the oldest).
--
-- Authored by Araza. Idempotent — safe to re-run (the DELETE is a no-op
-- once no collisions remain; DROP/ADD EXPRESSION errors if already
-- converted, hence the guard).

-- Dedupe rows that collide under the new normalization (keep the oldest).
delete from supplier_defaults a
using supplier_defaults b
where a.organization_id = b.organization_id
  and a.id > b.id
  and regexp_replace(lower(trim(a.vendor_name)), '[^a-z0-9]+', ' ', 'g')
    = regexp_replace(lower(trim(b.vendor_name)), '[^a-z0-9]+', ' ', 'g');

-- Rebuild the generated column with the stronger expression (PG 13+).
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'supplier_defaults'
      and column_name = 'vendor_name_normalized'
      and is_generated = 'ALWAYS'
  ) then
    alter table supplier_defaults
      alter column vendor_name_normalized drop expression;
    alter table supplier_defaults
      alter column vendor_name_normalized
      add generated always as (
        regexp_replace(lower(trim(vendor_name)), '[^a-z0-9]+', ' ', 'g')
      ) stored;
  end if;
end $$;
