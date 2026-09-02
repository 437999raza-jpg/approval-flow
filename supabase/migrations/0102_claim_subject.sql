-- Subject line for the holdback claim email.
--
-- retainage_claim_note (migration 0100) now holds the whole body rather
-- than a line appended to fixed wording, so the subject was the last
-- part still hardcoded. Both are templates with placeholders; null means
-- "use the built-in default", so nothing changes for an org that never
-- edits them.
--
-- Authored by Araza.

alter table organizations
  add column if not exists retainage_claim_subject text;

comment on column organizations.retainage_claim_subject is
  'Subject template for the holdback claim email. Supports the same {vendor} {project} {amount} {company} {term} {email} placeholders as the body. Null uses the default.';
comment on column organizations.retainage_claim_note is
  'Body template for the holdback claim email, with {vendor} {project} {amount} {company} {term} {email} placeholders. The bill breakdown is inserted at {bills}, or after the body when that token is absent. Null uses the default.';
