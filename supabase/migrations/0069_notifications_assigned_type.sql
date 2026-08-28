-- 0069: a second notifications.type, 'assigned' -- "it's your turn to
-- review this invoice" (sent whenever responsibility moves to a new
-- approver: entering the workflow, advancing to the next step, an admin
-- reassigning/setting a stage), alongside the existing 'mention' type.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('mention', 'assigned'));
