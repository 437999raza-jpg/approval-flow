-- 0078: allow 'search' as a third llm_usage_events.purpose value, for the
-- natural-language dashboard search (src/lib/nl-search.ts) alongside the
-- existing 'extract' and 'classify' calls.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table llm_usage_events drop constraint if exists llm_usage_events_purpose_check;
alter table llm_usage_events add constraint llm_usage_events_purpose_check
  check (purpose in ('extract', 'classify', 'search'));
