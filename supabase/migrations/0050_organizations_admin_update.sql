-- 0050: allow org ADMINS to UPDATE organizations (Settings).
--
-- The only in-app write to organizations is the default tax rate
-- (saveDefaultTaxRate). Members could already READ the row, but there was
-- NO update policy — RLS silently rejected the save (the action didn't check
-- the error either), so the rate never persisted and Settings kept showing
-- "No default set". This policy lets admins update the org row.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

drop policy if exists "organizations: admins can update" on organizations;
create policy "organizations: admins can update" on organizations
  for update using (is_org_admin(id)) with check (is_org_admin(id));
