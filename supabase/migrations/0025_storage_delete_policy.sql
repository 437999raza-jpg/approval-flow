-- Approval Flow: the "invoices" storage bucket had SELECT and INSERT
-- policies (migration 0001) but no DELETE policy — same silent-failure
-- class as migration 0023's audit_log gap. Supabase Storage's .remove()
-- doesn't throw when RLS blocks it; it just returns an empty result, so
-- every file-cleanup call has been a no-op: admin invoice deletion
-- (deleteInvoiceAction) never actually removed the file from Storage,
-- and confirming/dismissing a multi-invoice split never removed the
-- original combined upload either. Confirmed by testing directly: an
-- authenticated member's .remove() call against a real file returned []
-- with no error, and the file was still downloadable afterward.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "invoice files: members can delete" on storage.objects;
create policy "invoice files: members can delete"
  on storage.objects for delete
  using (
    bucket_id = 'invoices'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );
