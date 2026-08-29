-- 0084: vendor_statement_lines was missing an UPDATE policy entirely —
-- RLS defaults to deny with no policy, so updateStatementSupplier's
-- re-match (correcting the vendor, then rewriting each line's
-- match_status/matched_invoice_id) was silently a no-op: the statement's
-- own supplier_name update went through (that table has one), but the
-- per-line rewrite never actually applied. Same org-scoped-via-parent
-- pattern as the existing read/insert policies.
drop policy if exists "vendor_statement_lines: members can update" on vendor_statement_lines;
create policy "vendor_statement_lines: members can update" on vendor_statement_lines
  for update using (
    exists (
      select 1 from vendor_statements s
      where s.id = vendor_statement_lines.statement_id
        and is_org_member(s.organization_id)
    )
  );
