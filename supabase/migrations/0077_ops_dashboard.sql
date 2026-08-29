-- 0077: schema for the separate "Ufirst Ops" internal app -- support inbox
-- (reply to any customer without joining their org), OpenRouter token/cost
-- tracking, and feature flags with a live-refresh signal for the main app.
-- None of these tables are customer-facing: writes happen only through the
-- service-role client (Ops app, and a best-effort recorder in the main
-- app), never the anon/user-scoped client.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

-- One row per OpenRouter call (invoice extraction or multi-page
-- classification) -- Flow's own cost-of-goods tracking, not shown to
-- customers. cost_usd is null unless the request asked OpenRouter for
-- usage accounting (see src/lib/llm-usage.ts).
create table if not exists llm_usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purpose text not null check (purpose in ('extract', 'classify')),
  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric,
  created_at timestamptz not null default now()
);

create index if not exists llm_usage_events_org_created_idx
  on llm_usage_events (organization_id, created_at desc);

alter table llm_usage_events enable row level security;
-- No select/insert policy for the authenticated role: this table is only
-- ever touched via the service-role client, which bypasses RLS entirely.

-- Feature flags: a global default plus optional per-org overrides.
create table if not exists feature_flags (
  key text primary key,
  description text,
  global_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists feature_flag_overrides (
  id uuid primary key default gen_random_uuid(),
  flag_key text not null references feature_flags(key) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  unique (flag_key, organization_id)
);

alter table feature_flags enable row level security;
drop policy if exists "feature_flags: authenticated can read" on feature_flags;
create policy "feature_flags: authenticated can read" on feature_flags
  for select using (auth.uid() is not null);

alter table feature_flag_overrides enable row level security;
drop policy if exists "feature_flag_overrides: members can read own org" on feature_flag_overrides;
create policy "feature_flag_overrides: members can read own org" on feature_flag_overrides
  for select using (is_org_member(organization_id));

-- Single-row table: how the main app knows "something changed, refresh."
-- Bumped by the trigger below whenever a flag or override changes.
create table if not exists platform_config (
  id boolean primary key default true check (id),
  config_version integer not null default 1,
  updated_at timestamptz not null default now()
);
insert into platform_config (id, config_version)
  values (true, 1)
  on conflict (id) do nothing;

alter table platform_config enable row level security;
drop policy if exists "platform_config: authenticated can read" on platform_config;
create policy "platform_config: authenticated can read" on platform_config
  for select using (auth.uid() is not null);

create or replace function bump_platform_config_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update platform_config
    set config_version = config_version + 1,
        updated_at = now()
    where id = true;
  return null;
end;
$$;

drop trigger if exists feature_flags_bump_config on feature_flags;
create trigger feature_flags_bump_config
  after insert or update or delete on feature_flags
  for each statement execute function bump_platform_config_version();

drop trigger if exists feature_flag_overrides_bump_config on feature_flag_overrides;
create trigger feature_flag_overrides_bump_config
  after insert or update or delete on feature_flag_overrides
  for each statement execute function bump_platform_config_version();

-- Tracks when Ufirst last opened each org's support thread, so the Ops
-- inbox can show which customers have unread messages. No RLS read policy
-- for the authenticated role -- only the Ops app (service role) uses this.
create table if not exists support_thread_state (
  organization_id uuid primary key references organizations(id) on delete cascade,
  last_read_at timestamptz
);

alter table support_thread_state enable row level security;
