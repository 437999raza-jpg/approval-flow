-- Approval Flow: @mention teammates in Discussion, with an in-app
-- notification and (separately, app-side via Resend) an email so they
-- don't have to have the app open to find out.
--
-- mentioned_user_ids lives on invoice_comments itself (resolved
-- server-side from the composer's @mention picks, not parsed from free
-- text) so the comment always knows exactly who it was addressed to.
-- notifications is the in-app "you were mentioned" inbox — one row per
-- (comment, mentioned user), marked read when they open that invoice's
-- Discussion or the notification directly.
--
-- Authored by Araza. Idempotent — safe to re-run.

alter table invoice_comments
  add column if not exists mentioned_user_ids uuid[] not null default '{}';

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  actor_id uuid references profiles(id) on delete set null,
  invoice_id uuid references invoices(id) on delete cascade,
  comment_id uuid references invoice_comments(id) on delete cascade,
  type text not null default 'mention' check (type in ('mention')),
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_unread_idx
  on notifications (user_id, read, created_at desc);

alter table notifications enable row level security;

drop policy if exists "notifications: users can read their own" on notifications;
create policy "notifications: users can read their own" on notifications
  for select using (user_id = auth.uid());

drop policy if exists "notifications: members can insert" on notifications;
create policy "notifications: members can insert" on notifications
  for insert with check (is_org_member(organization_id));

drop policy if exists "notifications: users can update their own" on notifications;
create policy "notifications: users can update their own" on notifications
  for update using (user_id = auth.uid());
