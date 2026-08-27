-- Flow's own usage billing: track how many documents each client org has
-- processed, and the per-org rate (USD per document). The SaaS charges the
-- client per document processed — the invoice is sent manually (this is
-- tracking only, no payment processor). Recorded at the point a document
-- is ACCEPTED into the pipeline (webhook download / manual upload), never
-- at retry time, so one document always counts once.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_name text not null,
  source text not null default 'email',   -- 'email' | 'manual'
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

-- Members can read their own org's usage (the Billing page); inserts happen
-- server-side (webhook admin client, upload route member client).
drop policy if exists "usage_events: members can read" on usage_events;
create policy "usage_events: members can read" on usage_events
  for select using (is_org_member(organization_id));

drop policy if exists "usage_events: members can insert" on usage_events;
create policy "usage_events: members can insert" on usage_events
  for insert with check (is_org_member(organization_id));

create index if not exists usage_events_org_created_idx
  on usage_events (organization_id, created_at desc);

-- Per-org charge per document processed, in USD. Default 0.15.
alter table public.organizations
  add column if not exists usage_rate_usd numeric not null default 0.15;
