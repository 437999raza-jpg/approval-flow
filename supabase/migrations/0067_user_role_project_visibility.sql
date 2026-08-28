-- 0067: a plain "user" org member should only see invoices for the
-- projects they're actually assigned to (via workflow step approver
-- conditions — the same "Customer" condition that already drives approval
-- eligibility, reused here rather than building a second, separate
-- assignment concept) plus whatever they submitted themselves. Admins and
-- auditors are unaffected (both already bypass this branch entirely via
-- is_org_admin/is_org_auditor).
--
-- Previously `project_id is null` gave every member blanket visibility
-- into any invoice with no project set at all, regardless of eligibility
-- — dropped here so "cannot see anyone else's invoices" actually holds.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create or replace function can_see_invoice(inv_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from invoices i
    where i.id = inv_id
      and (
        is_org_admin(i.organization_id)
        or is_org_auditor(i.organization_id)
        or (
          is_org_member(i.organization_id)
          and (
            i.submitted_by = auth.uid()
            or is_eligible_approver(i.id, auth.uid())
          )
        )
      )
  );
$$;

drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (
    is_org_admin(organization_id)
    or is_org_auditor(organization_id)
    or (
      is_org_member(organization_id)
      and status <> 'on_review'
      and (
        submitted_by = auth.uid()
        or is_eligible_approver(id, auth.uid())
      )
    )
  );

drop policy if exists "invoices: members can update" on invoices;
create policy "invoices: members can update" on invoices
  for update using (
    (
      is_org_admin(organization_id)
      or is_org_auditor(organization_id)
      or (
        is_org_member(organization_id)
        and status <> 'on_review'
        and (
          submitted_by = auth.uid()
          or is_eligible_approver(id, auth.uid())
        )
      )
    )
    and not is_org_auditor(organization_id)
  );
