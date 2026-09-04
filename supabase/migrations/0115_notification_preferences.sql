-- Per-user email preferences, modeled on ApprovalMax's "Edit profile" ->
-- Notifications tab. Scope deliberately narrow: only the three emails
-- that are a personal convenience, not a business-risk alert, are
-- user-toggleable at all.
--
-- Escalation emails are NOT included here on purpose, even though an
-- earlier draft of this feature had them toggleable — the whole point
-- of an escalation is to reach someone through a channel they might
-- otherwise be missing (that's why it fires in the first place), so
-- letting the person being escalated to silence it would defeat it.
-- Same reasoning already applies to QBO-disconnect, unpaid-usage,
-- trial-ending and no-approver-match — none of those are stored here
-- either, they stay unconditional exactly as built earlier this
-- session.
--
-- digest_days/digest_hour/timezone give the daily digest a real
-- ApprovalMax-style day-of-week + time picker instead of a blunt
-- on/off. Default is weekdays-only at 9am in a Canadian timezone
-- (this customer base's default), a deliberate design choice — not a
-- reproduction of the old "every day, whenever the cron happens to
-- run" behavior, since nobody's approving invoices on a Saturday.
--
-- No row for a user means "use the defaults" everywhere this is read.
--
-- Authored by Araza.

create table if not exists user_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mentions_enabled boolean not null default true,
  assigned_enabled boolean not null default true,
  digest_enabled boolean not null default true,
  digest_days text[] not null default '{mon,tue,wed,thu,fri}',
  digest_hour smallint not null default 9,
  timezone text not null default 'America/Toronto',
  digest_last_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table user_notification_preferences enable row level security;

create policy "users manage their own notification preferences"
  on user_notification_preferences
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
