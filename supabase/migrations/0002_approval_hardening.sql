-- Approval Flow: approval hardening + comments/audit support.
-- Authored by Araza.
-- Run after 0001_init.sql (same instructions: `supabase db push` or paste
-- into the SQL editor).

-- 1) One decision per invoice step. Makes duplicate approve/reject rows
--    impossible even when two approvers race, and gives app code a
--    constraint it can rely on for idempotency.
alter table invoice_approvals
  add constraint invoice_approvals_invoice_step_unique unique (invoice_id, step_order);

-- 2) Chat history is read in chronological order per invoice.
create index if not exists invoice_comments_invoice_created_idx
  on invoice_comments (invoice_id, created_at);

-- 3) Let org members see each other's profile names, so comment authors and
--    approver names can be displayed (and included in the audit document).
--    Scoped: the viewer and the target profile must share at least one
--    organization. Complements the existing "profiles: read own" policy.
create policy "profiles: org members can read" on profiles
  for select using (
    exists (
      select 1
      from organization_members viewer
      join organization_members target
        on target.organization_id = viewer.organization_id
      where viewer.user_id = auth.uid()
        and target.user_id = profiles.id
    )
  );
