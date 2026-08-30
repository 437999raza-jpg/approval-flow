-- Enables Supabase Realtime (Postgres Changes) for the Discussion thread —
-- posting a comment previously only updated the SAME tab that posted it
-- (server-action revalidatePath/revalidateTag), everyone else needed a
-- manual refresh to see it. Realtime respects the table's existing RLS
-- (invoice_comments: members can read, via can_see_invoice — migration
-- 0008), so no new policy is needed, just turning replication on.
alter publication supabase_realtime add table invoice_comments;
