-- A bulk-imported historical bill (qbo_bill_import_jobs, migration 0104
-- — the platform-admin onboarding tool that pulls a customer's pre-Flow
-- QuickBooks bill history straight in) was being written with
-- source: 'manual', indistinguishable from something a person actually
-- uploaded. Requested live so an imported invoice can be visibly tagged
-- ("came from QBO") rather than looking identical to a normal upload.
--
-- Authored by Araza.

alter table invoices drop constraint if exists invoices_source_check;
alter table invoices add constraint invoices_source_check
  check (source in ('manual', 'email', 'qbo_import'));
