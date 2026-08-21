-- Approval Flow: close a real read-only gap for the auditor role.
--
-- Every other write path (invoices UPDATE, line items, comments, documents,
-- decisions, projects, workflows) was already gated with
-- `and not is_org_auditor(organization_id)` back in migration 0014 — except
-- this one. "invoices: members can insert" (0001) only ever checked
-- is_org_member(), which is true for admin/auditor/user alike, so an
-- auditor could create a brand new invoice via manual upload
-- (POST /api/invoices/upload, which runs on the signed-in user's own RLS-
-- bound session, not a service-role client) despite the role being
-- documented everywhere else as fully read-only. Confirmed live: logged in
-- as an auditor, "+ Add invoice" was reachable and worked.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "invoices: members can insert" on invoices;
create policy "invoices: members can insert" on invoices
  for insert with check (
    is_org_member(organization_id) and not is_org_auditor(organization_id)
  );

-- Same gap, lower stakes: these two are only ever hit today as a side
-- effect of an already-gated primary action (audit_log after a decision,
-- notifications after a comment), so an auditor can't actually reach them
-- through the app's own UI — but closing them anyway keeps "read-only"
-- true at the RLS layer itself, not just "true for the paths we thought
-- to check."
drop policy if exists "audit_log: members can insert" on audit_log;
create policy "audit_log: members can insert" on audit_log
  for insert with check (
    is_org_member(organization_id) and not is_org_auditor(organization_id)
  );

drop policy if exists "notifications: members can insert" on notifications;
create policy "notifications: members can insert" on notifications
  for insert with check (
    is_org_member(organization_id) and not is_org_auditor(organization_id)
  );
