-- 0053: admins can REMOVE entries from the inbound email queue (bad/spam
-- messages, tests, wrong recipients). Members can still read; only admins
-- can delete. Mirrors the read policy's organization_id-null guard.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "inbound_email_log: admins can delete" on inbound_email_log;
create policy "inbound_email_log: admins can delete" on inbound_email_log
  for delete using (
    organization_id is not null and is_org_admin(organization_id)
  );
