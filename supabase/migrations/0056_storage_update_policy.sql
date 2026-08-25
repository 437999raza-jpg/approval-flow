-- 0056: storage UPDATE policy for the invoices bucket.
--
-- Reordering pages (Reorder pages…) replaces the stored PDF in place via an
-- upsert. storage.objects only had INSERT / SELECT / DELETE policies for
-- the invoices bucket, so the upsert failed with "new row violates
-- row-level security policy". This lets org members update their own
-- bucket files (same org-folder check as the insert policy).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "invoice files: members can update" on storage.objects;
create policy "invoice files: members can update" on storage.objects
  for update using (
    bucket_id = 'invoices'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );
