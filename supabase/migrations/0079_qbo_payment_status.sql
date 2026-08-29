-- 0079: track whether a bill pushed to QBO has actually been paid, per
-- QuickBooks (a Bill's own Balance field + linked BillPayment date) - kept
-- current by a nightly cron (/api/cron/qbo-payment-sync) and a manual
-- "Sync payment status" button in Settings.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table invoices add column if not exists qbo_payment_status text;
alter table invoices drop constraint if exists invoices_qbo_payment_status_check;
alter table invoices add constraint invoices_qbo_payment_status_check
  check (qbo_payment_status is null or qbo_payment_status in ('paid', 'unpaid'));

alter table invoices add column if not exists qbo_paid_at timestamptz;

alter table qbo_sync_log drop constraint if exists qbo_sync_log_section_check;
alter table qbo_sync_log add constraint qbo_sync_log_section_check
  check (section in ('taxes', 'classes', 'categories', 'suppliers', 'projects', 'payment_status'));
