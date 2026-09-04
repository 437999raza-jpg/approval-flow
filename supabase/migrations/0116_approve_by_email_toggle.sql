-- Per-user opt-out of approve/reject-by-email (migration 0115 laid the
-- table down; this is the flag for the one-click decision links added
-- to the "it's your turn" email — see decision-token.ts). Defaults on,
-- matching every other toggle in this table — it's the whole point of
-- the feature — but someone on a shared inbox, or who just doesn't want
-- a bill decided by a click instead of a login, can turn it off here.
--
-- Turning this off does NOT invalidate links already sent (a stateless
-- HMAC token, not a DB-backed one) — it only stops FUTURE emails from
-- including the buttons. Existing unopened emails from before the
-- toggle still work until they naturally expire (14 days) or the
-- invoice moves off that step.
--
-- Authored by Araza.

alter table user_notification_preferences
  add column if not exists approve_by_email_enabled boolean not null default true;
