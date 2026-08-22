-- 0045: store which specific QBO tax CODE was selected on a line, not just
-- its resolved percentage. Two codes can share the same rate (this app has
-- seen "H" and "M&E (ON)" both resolve to 13%) -- tax_rate alone can't tell
-- them apart, so syncToQbo couldn't know which TaxCodeRef to send without
-- guessing. The Tax field now submits the exact QBO tax code id; tax_rate
-- is kept alongside it (still needed for the app's own tax-total math and
-- display) but is no longer the only record of what was picked.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoice_line_items add column if not exists qbo_tax_code_id text;
