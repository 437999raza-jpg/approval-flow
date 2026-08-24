-- 0052: track which pending-split reviews an inbound email produced, so the
-- Email queue page can link "split review" emails straight to the review
-- instead of only counting them.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table inbound_email_log add column if not exists pending_split_ids uuid[] not null default '{}';
