-- Fix: the 0006 "organization_members: admins manage" policy recursed
-- infinitely. It queried organization_members directly inside its own
-- policy, so ANY read of the table (e.g. the dashboard's current-org
-- lookup) failed with "infinite recursion detected in policy".
--
-- Fix: an admin check that runs with SECURITY DEFINER (bypasses RLS), so
-- evaluating the policy no longer re-enters the table's policies.
-- Authored by Araza. Idempotent — safe to re-run.

create or replace function is_org_admin(org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org_id
      and user_id = auth.uid()
      and role = 'admin'
  );
$$;

drop policy if exists "organization_members: admins manage" on organization_members;

create policy "organization_members: admins manage" on organization_members
  for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));
