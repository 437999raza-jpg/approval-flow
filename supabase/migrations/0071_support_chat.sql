-- 0071: a simple support chat — one continuous thread per organization,
-- any member can read/post, so a customer can reach the platform owner
-- directly instead of email. Platform admins reach it the same way
-- regular members do: by being an actual organization_members row on
-- that org (already how admin-created orgs work — see
-- createOrganizationAction/joinOrganizationAction), not a separate
-- cross-org bypass table.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists support_messages_org_idx
  on support_messages (organization_id, created_at);

alter table support_messages enable row level security;

drop policy if exists "support_messages: members can read" on support_messages;
create policy "support_messages: members can read" on support_messages
  for select using (is_org_member(organization_id));

drop policy if exists "support_messages: members can insert" on support_messages;
create policy "support_messages: members can insert" on support_messages
  for insert with check (is_org_member(organization_id));
