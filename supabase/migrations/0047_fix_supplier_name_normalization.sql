-- 0047: fix a real matching bug found while bulk-seeding supplier
-- defaults. supplier_defaults.vendor_name_normalized (a generated column,
-- 0020/0031) computes trim(lower(vendor_name)) THEN collapses runs of
-- non-alphanumeric characters to a single space -- but never trims again
-- afterward. Any vendor name ending in punctuation (e.g. "Marsil
-- Mechanical Inc.") collapses its trailing period into a trailing SPACE,
-- e.g. "marsil mechanical inc ". normalizeForMatching() in
-- src/lib/matching.ts (used everywhere else this app matches vendor
-- names, including at invoice ingestion) trims AFTER the collapse and
-- produces "marsil mechanical inc" -- no trailing space. The two never
-- matched for any such vendor, so a saved supplier rule for a name ending
-- in punctuation was silently never applied at ingestion.
--
-- Postgres can't ALTER a stored generated column's expression in place,
-- so the column is dropped and re-added with an extra outer trim() to
-- match normalizeForMatching() exactly. Recomputes for all existing rows.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table supplier_defaults drop constraint if exists supplier_defaults_org_vendor_name_unique;
alter table supplier_defaults drop column if exists vendor_name_normalized;
alter table supplier_defaults add column vendor_name_normalized text generated always as (
  trim(regexp_replace(lower(trim(vendor_name)), '[^a-z0-9]+', ' ', 'g'))
) stored;
alter table supplier_defaults add constraint supplier_defaults_org_vendor_name_unique
  unique (organization_id, vendor_name_normalized);
