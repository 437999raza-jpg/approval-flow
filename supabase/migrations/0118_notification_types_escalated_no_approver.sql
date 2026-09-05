-- Two more notifications.type values: 'escalated' and 'no_approver'.
-- Both already exist as emails (sendEscalationEmail/sendNoApproverMatchEmail,
-- src/app/api/cron/reminders/route.ts) but had no in-app equivalent — the
-- bell only ever knew about mention/assigned/rejected, so anyone who
-- doesn't read the email (or reads it on a phone, dismisses it, and
-- forgets) has no record it happened at all once it scrolls out of their
-- inbox. Digest is deliberately NOT added here: it's just a restatement
-- of what the Dashboard's own pending/mine view already shows live, so
-- an in-app row for it would be pure noise, not new information.
--
-- Authored by Araza.

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('mention', 'assigned', 'rejected', 'escalated', 'no_approver'));
