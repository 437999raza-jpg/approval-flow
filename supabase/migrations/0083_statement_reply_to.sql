-- 0083: a per-org Reply-To for vendor-facing statement emails — Flow
-- still sends from its own verified address (RESEND_FROM_EMAIL), but a
-- vendor's reply should land in the client's own inbox, not Flow's.
alter table organizations add column if not exists statement_reply_to text;
