-- 0072: a third notifications.type, 'rejected' -- sent to the submitter
-- when their invoice is rejected. Previously nothing notified them at
-- all beyond a Discussion comment they'd only see if they happened to
-- reopen the invoice. Alongside the existing 'mention'/'assigned' types.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('mention', 'assigned', 'rejected'));
