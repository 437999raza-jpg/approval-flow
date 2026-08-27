-- 0065: drop the CO/Extras flag entirely. This auto-stamp feature (added by
-- migration 0042) never actually worked -- its "stamp Extras on lines
-- without a class" filter used `.not("class", "in", '("Contract",
-- "Change Orders")')`, which under SQL three-valued logic never matches a
-- NULL class (the normal unset state), so it silently never fired for a
-- typical bill. It's also been fully superseded by the per-line CON/CO
-- toggle buttons on the line-item Class field, which tag each line
-- directly and correctly. Confirmed no invoice had the flag set to true
-- and no line item had class = 'Extras' before dropping -- nothing lost.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices drop column if exists has_cos_or_extras;
