-- Approval Flow: admin-only permanent invoice deletion.
--
-- 1. audit_log.invoice_id currently cascades on invoice delete, which
--    would wipe out the very "invoice.deleted" entry recording the
--    deletion the moment it happens — the one event that most needs to
--    survive. Switch to "on delete set null": historical audit rows stay
--    (with invoice_id now null, invoice_number/vendor already live in
--    metadata for anything logged going forward), only the FK link goes.
-- 2. invoices had no DELETE policy at all (RLS defaults to deny), so this
--    also adds one, admin-only. Every child table (line items, documents,
--    comments, approvals) already cascades on invoice delete (0001/0003/
--    0005), so a single row delete is enough.
--
-- Authored by Araza. Idempotent — safe to re-run.

alter table audit_log drop constraint if exists audit_log_invoice_id_fkey;
alter table audit_log
  add constraint audit_log_invoice_id_fkey
  foreign key (invoice_id) references invoices(id) on delete set null;

drop policy if exists "invoices: admins can delete" on invoices;
create policy "invoices: admins can delete" on invoices
  for delete using (is_org_admin(organization_id));
