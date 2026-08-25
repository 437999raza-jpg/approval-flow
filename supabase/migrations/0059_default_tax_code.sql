-- 0059: organizations.default_tax_code_id — the default tax for new invoices
-- stored as a specific QBO tax CODE (e.g. H 13%), not just a rate.
--
-- Why: H and "M&E (ON)" are both 13%, and the QBO sync refuses to guess
-- between duplicate-rate codes. Ingest applies the rate (13) but the lines
-- carry no code, so the sync can't pick H. Storing the CODE removes the
-- ambiguity: new lines get the exact code (H), and the sync posts it
-- directly.
--
-- Backfill: orgs that already have default_tax_rate get the synced code with
-- that rate, preferring a code literally named "H" (case-insensitive), then
-- alphabetical.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists default_tax_code_id text;

update organizations o
  set default_tax_code_id = (
    select c.qbo_tax_code_id
    from qbo_tax_codes c
    where c.organization_id = o.id
      and c.rate_value = o.default_tax_rate
    order by (lower(c.name) = 'h') desc, c.name asc
    limit 1
  )
  where o.default_tax_rate is not null
    and o.default_tax_code_id is null;
