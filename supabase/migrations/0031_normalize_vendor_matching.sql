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
-- NOTE: Postgres has no "ALTER COLUMN ... ADD GENERATED AS (...)" — a
-- generated column's expression can only be set at CREATE/ADD COLUMN, so
-- the column is dropped and re-created (its unique constraint goes with it
-- and is re-added). The guard checks the live expression first, so
-- re-running is a no-op once the strong expression is in place.
--
-- Authored by Araza. Idempotent — safe to re-run.

-- Dedupe rows that collide under the new normalization (keep the oldest).
delete from supplier_defaults a
using supplier_defaults b
where a.organization_id = b.organization_id
  and a.id > b.id
  and regexp_replace(lower(trim(a.vendor_name)), '[^a-z0-9]+', ' ', 'g')
    = regexp_replace(lower(trim(b.vendor_name)), '[^a-z0-9]+', ' ', 'g');

-- Rebuild the generated column with the stronger expression, unless it is
-- already the strong one.
do $$
begin
  if not exists (
    select 1
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where a.attrelid = 'supplier_defaults'::regclass
      and a.attname = 'vendor_name_normalized'
      and pg_get_expr(d.adbin, d.adrelid) like '%regexp_replace%'
  ) then
    alter table supplier_defaults drop column vendor_name_normalized;
    alter table supplier_defaults add column vendor_name_normalized text
      generated always as (
        regexp_replace(lower(trim(vendor_name)), '[^a-z0-9]+', ' ', 'g')
      ) stored;
    alter table supplier_defaults
      add constraint supplier_defaults_org_vendor_name_unique
      unique (organization_id, vendor_name_normalized);
  end if;
end $$;
