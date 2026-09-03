-- Guards the "we received your invoice" acknowledgement email so the
-- fold-backup-docs reconciliation (which can run more than once for the
-- same email as sibling attachments settle) never sends it twice.
--
-- Authored by Araza.

alter table inbound_email_log add column if not exists receipt_ack_sent boolean not null default false;
