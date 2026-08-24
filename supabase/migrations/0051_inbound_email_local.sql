-- 0051: friendly per-org capture addresses on the shared inbound domain.
--
-- Clients email invoices to {companyname}@{INBOUND_EMAIL_DOMAIN} (e.g.
-- fluid@flow.ufirst.co) instead of a random token — the same model as
-- ApprovalMax/Dext: the address is on OUR domain, the client changes
-- nothing, and they log in at our app to manage invoices.
--
-- inbound_email_local — the friendly local part (lowercase letters, digits,
-- dash, underscore, dot; up to 64 chars). When set, BOTH the friendly local
-- part and the token still resolve to the org; when null, the token keeps
-- working exactly as before. Unique across tenants (one shared domain).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists inbound_email_local text;

alter table organizations add constraint organizations_inbound_email_local_format
  check (inbound_email_local is null
    or inbound_email_local ~ '^[a-z0-9][a-z0-9._-]{0,63}$');

create unique index if not exists organizations_inbound_email_local_unique
  on organizations (inbound_email_local) where inbound_email_local is not null;
