-- Tracks whether the sender of an inbound email has already been sent
-- the "please send PDFs" nudge recently — a per-row flag rather than a
-- separate table, checked against inbound_email_log's own from_address
-- + created_at, so no new table is needed just to rate-limit one email.
--
-- Authored by Araza.

alter table inbound_email_log add column if not exists pdf_nudge_sent boolean not null default false;
