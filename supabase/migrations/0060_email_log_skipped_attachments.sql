-- Record attachments dropped from an inbound email so nothing silently
-- disappears: signature/logo images (never invoices) and non-PDF files
-- (spreadsheets etc.) that the app cannot process.
alter table public.inbound_email_log
  add column if not exists skipped_attachments jsonb;
