-- 0039: add the 'qbo_ready' status — the admin-only final gate.
--
-- When a bill completes EVERY step of its approval workflow it lands in
-- 'qbo_ready' (not 'approved'). It sits there until an admin presses the
-- final "Sync to QuickBooks" button, which is the only thing that sends
-- the bill to QBO. This enforces the hard rule: no bill reaches QBO until
-- the full workflow is done AND an admin explicitly releases it.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices drop constraint if exists invoices_status_check;

-- Fully-approved invoices that were never synced to QBO become 'qbo_ready'
-- (they need the admin's final release). Ones already synced stay 'approved'.
update invoices set status = 'qbo_ready'
where status = 'approved' and coalesce(qbo_sync_status, '') <> 'synced';

alter table invoices add constraint invoices_status_check
  check (status in ('on_review', 'on_approval', 'qbo_ready', 'approved', 'cancelled', 'rejected', 'on_hold'));
