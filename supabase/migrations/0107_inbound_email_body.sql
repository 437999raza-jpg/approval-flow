-- The webhook payload Resend posts for a received email is metadata
-- only (from/to/subject) — never the body. Until now nothing fetched it,
-- so a vendor's own written instructions in the email itself (as opposed
-- to the attached invoice) were only ever visible in whoever's inbox
-- forwarded it — invisible the moment vendors email Flow directly.
--
-- Authored by Araza.

alter table inbound_email_log add column if not exists body_text text;

comment on column inbound_email_log.body_text is
  'Plain-text body of the received email, fetched from Resend''s receiving API (GET /emails/receiving/{id}) — the webhook event itself never includes it.';
