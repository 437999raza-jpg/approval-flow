-- Track when the org's per-document usage rate was last saved, so the
-- Billing page can show "0.15 — saved on <date>" and grey the Save button
-- until the value changes again.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table public.organizations
  add column if not exists usage_rate_updated_at timestamptz;

-- Existing rows: treat the current rate as "saved now" so the page has a
-- date to show (rather than a blank "never saved").
update public.organizations
  set usage_rate_updated_at = now()
  where usage_rate_updated_at is null
    and usage_rate_usd is not null;
