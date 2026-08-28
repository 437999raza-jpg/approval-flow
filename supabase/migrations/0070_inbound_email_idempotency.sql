-- 0070: inbound_email_log.email_id -- Resend's own id for the received
-- email, used to make the webhook idempotent against retried deliveries.
--
-- Root cause of a real, repeated incident: this webhook does real work
-- synchronously (list/download attachments, then run the ingest queue for
-- up to 35s) before ever returning a response. If Resend doesn't get a
-- fast reply, it retries delivery of the SAME email.received event — and
-- the handler had no way to tell "I've already seen this exact delivery"
-- from "this is a brand new email". A retry created a second
-- inbound_email_log row and a second set of ingest_jobs for the SAME
-- attachments, producing duplicate invoices for the same email
-- (reported live, repeatedly, for the same supplier's invoices). This is
-- NOT the "possible duplicate" business case (a genuine resubmission/
-- amendment that must go through review) -- it's the literal same event
-- notification arriving twice, which should never be processed twice at
-- all.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table inbound_email_log add column if not exists email_id text;

create unique index if not exists inbound_email_log_email_id_unique
  on inbound_email_log (email_id) where email_id is not null;
