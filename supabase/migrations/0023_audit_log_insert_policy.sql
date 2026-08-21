-- Approval Flow: audit_log had RLS enabled (migration 0001) but no INSERT
-- policy was ever added for it — only a SELECT policy. With RLS enabled
-- and no matching policy, Postgres denies by default, so every audit_log
-- insert made through the regular (non-service-role) client has been
-- silently failing since day one: decide/cancelInvoice/reassignApprover/
-- overrideStatus/reExtract and everything added this session (bill edits,
-- line item changes, document uploads, accounting instructions, invoice
-- deletion) never actually wrote a row. Only the inbound-email webhook
-- (which uses the service-role key, bypassing RLS) ever succeeded — which
-- is exactly the one row that showed up when checking the table.
--
-- Authored by Araza. Idempotent — safe to re-run.

drop policy if exists "audit_log: members can insert" on audit_log;
create policy "audit_log: members can insert" on audit_log
  for insert with check (is_org_member(organization_id));
