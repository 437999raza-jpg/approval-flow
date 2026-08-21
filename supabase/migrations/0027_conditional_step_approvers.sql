-- Approval Flow: replace "one approver per step" with ApprovalMax-style
-- conditional routing — a step can have several approvers, each matched
-- by their own Class/Customer/Supplier condition, plus an optional
-- Default Approver used when nobody's condition matches. This is what
-- lets ONE workflow cover every project instead of needing a separate
-- workflow per project/customer (the actual problem being solved here —
-- see the "175 projects" conversation this migration comes out of).
--
-- Visibility changes to match: instead of "any approver on a workflow
-- linked to this invoice's project can see it" (approval_workflow_projects),
-- it's now "you can see this invoice if one of your own conditions
-- actually matches it (or you're a default approver on the workflow)" —
-- see is_eligible_approver() below. approval_workflow_projects is no
-- longer needed and is dropped.
--
-- Authored by Araza. Idempotent — safe to re-run.

-- ---------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------

alter table approval_workflow_steps add column if not exists name text not null default '';
alter table approval_workflow_steps add column if not exists approval_mode text not null default 'all'
  check (approval_mode in ('any', 'all'));
comment on column approval_workflow_steps.approval_mode is
  'When more than one approver''s condition matches the same invoice at this step: ''all'' requires every matching approver to approve; ''any'' completes the step on the first approval.';

create table if not exists approval_workflow_step_approvers (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references approval_workflow_steps(id) on delete cascade,
  approver_user_id uuid not null references profiles(id) on delete cascade,
  -- Fallback approver for this step, used only when no conditional
  -- approver's rules match the invoice. Not itself conditional.
  is_default boolean not null default false,
  row_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (step_id, approver_user_id)
);

create index if not exists approval_workflow_step_approvers_step_idx
  on approval_workflow_step_approvers (step_id);

create table if not exists approval_workflow_step_conditions (
  id uuid primary key default gen_random_uuid(),
  step_approver_id uuid not null references approval_workflow_step_approvers(id) on delete cascade,
  field text not null check (field in ('class', 'customer', 'supplier')),
  -- 'matches' = this approver is eligible only when the invoice's value(s)
  -- overlap match_values; 'not_matches' = eligible only when they don't.
  operator text not null check (operator in ('matches', 'not_matches')),
  -- Free text for class/supplier; project ids (as text) for customer.
  -- Multiple values = OR within this one condition row. Named
  -- match_values (not "values") since VALUES is a reserved SQL keyword.
  match_values text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists approval_workflow_step_conditions_approver_idx
  on approval_workflow_step_conditions (step_approver_id);

-- Preserve any existing single-approver assignment as that step's default
-- approver before dropping the old column — costs nothing and avoids
-- silently orphaning a real assignment, even though a clean rebuild of
-- the one real workflow is the plan going forward. Guarded on the column
-- still existing so this stays safe to re-run even after a prior run
-- already dropped it (a plain `insert ... select approver_user_id from
-- approval_workflow_steps` would otherwise fail with "column does not
-- exist" on a second run).
do $migrate_old_approvers$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'approval_workflow_steps' and column_name = 'approver_user_id'
  ) then
    insert into approval_workflow_step_approvers (step_id, approver_user_id, is_default)
    select id, approver_user_id, true
    from approval_workflow_steps
    where approver_user_id is not null
    on conflict (step_id, approver_user_id) do nothing;
  end if;
end
$migrate_old_approvers$;

-- Column is dropped further down, after the invoices policies that
-- currently reference it (directly, via ws.approver_user_id) are replaced
-- with versions that don't — Postgres tracks column dependencies through
-- RLS policy expressions, so dropping it first errors with "cannot drop
-- column ... other objects depend on it".

-- ---------------------------------------------------------------------
-- RLS: new tables (members read, admins manage — same pattern as
-- approval_workflow_rules in 0009_workflow_rules.sql)
-- ---------------------------------------------------------------------

alter table approval_workflow_step_approvers enable row level security;

drop policy if exists "step_approvers: members can read" on approval_workflow_step_approvers;
create policy "step_approvers: members can read" on approval_workflow_step_approvers
  for select using (
    exists (
      select 1 from approval_workflow_steps s
      join approval_workflows w on w.id = s.workflow_id
      where s.id = step_id and is_org_member(w.organization_id)
    )
  );

drop policy if exists "step_approvers: admins manage" on approval_workflow_step_approvers;
create policy "step_approvers: admins manage" on approval_workflow_step_approvers
  for all
  using (
    exists (
      select 1 from approval_workflow_steps s
      join approval_workflows w on w.id = s.workflow_id
      where s.id = step_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflow_steps s
      join approval_workflows w on w.id = s.workflow_id
      where s.id = step_id and is_org_admin(w.organization_id)
    )
  );

alter table approval_workflow_step_conditions enable row level security;

drop policy if exists "step_conditions: members can read" on approval_workflow_step_conditions;
create policy "step_conditions: members can read" on approval_workflow_step_conditions
  for select using (
    exists (
      select 1 from approval_workflow_step_approvers sa
      join approval_workflow_steps s on s.id = sa.step_id
      join approval_workflows w on w.id = s.workflow_id
      where sa.id = step_approver_id and is_org_member(w.organization_id)
    )
  );

drop policy if exists "step_conditions: admins manage" on approval_workflow_step_conditions;
create policy "step_conditions: admins manage" on approval_workflow_step_conditions
  for all
  using (
    exists (
      select 1 from approval_workflow_step_approvers sa
      join approval_workflow_steps s on s.id = sa.step_id
      join approval_workflows w on w.id = s.workflow_id
      where sa.id = step_approver_id and is_org_admin(w.organization_id)
    )
  )
  with check (
    exists (
      select 1 from approval_workflow_step_approvers sa
      join approval_workflow_steps s on s.id = sa.step_id
      join approval_workflows w on w.id = s.workflow_id
      where sa.id = step_approver_id and is_org_admin(w.organization_id)
    )
  );

-- ---------------------------------------------------------------------
-- Visibility: is a given user an eligible approver anywhere on this
-- invoice's workflow — i.e. would they end up as the effective approver
-- of some step, given the invoice's actual class/customer(project)/
-- supplier data? Forward-looking (checks every step, not just the
-- current one) so an approver on a later step can already see the
-- invoice, matching the old project-linked behavior. Default approvers
-- can always see the workflow's invoices (they're the catch-all for
-- whichever step they're on).
-- ---------------------------------------------------------------------

create or replace function is_eligible_approver(p_invoice_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_workflow_id uuid;
  v_vendor text;
  v_classes text[];
  v_project_ids text[];
  r_approver record;
  r_cond record;
  v_cond_values text[];
  approver_ok boolean;
begin
  select workflow_id, lower(trim(coalesce(vendor_name, '')))
    into v_workflow_id, v_vendor
    from invoices where id = p_invoice_id;

  if v_workflow_id is null then
    return false;
  end if;

  select coalesce(array_agg(distinct lower(trim(class))) filter (where class is not null and trim(class) <> ''), '{}')
    into v_classes
    from invoice_line_items where invoice_id = p_invoice_id;

  select coalesce(array_agg(distinct project_id::text) filter (where project_id is not null), '{}')
    into v_project_ids
    from invoice_line_items where invoice_id = p_invoice_id;
  if coalesce(array_length(v_project_ids, 1), 0) = 0 then
    select case when project_id is not null then array[project_id::text] else '{}'::text[] end
      into v_project_ids
      from invoices where id = p_invoice_id;
  end if;

  for r_approver in
    select sa.id, sa.is_default
    from approval_workflow_step_approvers sa
    join approval_workflow_steps s on s.id = sa.step_id
    where s.workflow_id = v_workflow_id
      and sa.approver_user_id = p_user_id
  loop
    if r_approver.is_default then
      return true;
    end if;

    approver_ok := true;
    for r_cond in
      select field, operator, match_values
      from approval_workflow_step_conditions
      where step_approver_id = r_approver.id
    loop
      select array_agg(lower(trim(x))) into v_cond_values from unnest(r_cond.match_values) x;
      v_cond_values := coalesce(v_cond_values, '{}');

      if r_cond.field = 'supplier' then
        if r_cond.operator = 'matches' and not (v_vendor = any(v_cond_values)) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_vendor = any(v_cond_values)) then
          approver_ok := false;
        end if;
      elsif r_cond.field = 'class' then
        if r_cond.operator = 'matches' and not (v_classes && v_cond_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_classes && v_cond_values) then
          approver_ok := false;
        end if;
      elsif r_cond.field = 'customer' then
        -- customer values are project ids (uuids as text) — no case
        -- folding, compare against r_cond.match_values directly.
        if r_cond.operator = 'matches' and not (v_project_ids && r_cond.match_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_project_ids && r_cond.match_values) then
          approver_ok := false;
        end if;
      end if;

      exit when approver_ok = false;
    end loop;

    if approver_ok then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

-- ---------------------------------------------------------------------
-- can_see_invoice(): swap the approval_workflow_projects join for
-- is_eligible_approver(). Used directly by invoice_approvals/
-- invoice_comments/invoice_documents/invoice_line_items/audit_log's own
-- policies (0008_workflow_access.sql), so redefining it here is enough
-- to update visibility everywhere those tables are concerned.
-- ---------------------------------------------------------------------

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
        or (
          is_org_member(i.organization_id)
          and (
            i.project_id is null
            or i.submitted_by = auth.uid()
            or is_eligible_approver(i.id, auth.uid())
          )
        )
      )
  );
$$;

-- invoices' own SELECT/UPDATE policies inline this same logic instead of
-- calling can_see_invoice() — a self-referential subquery inside
-- can_see_invoice() breaks INSERT ... RETURNING (see 0021's comment for
-- the full explanation). Redefine them the same way, just swapping in
-- is_eligible_approver().
drop policy if exists "invoices: members can read" on invoices;
create policy "invoices: members can read" on invoices
  for select using (
    is_org_admin(organization_id)
    or is_org_auditor(organization_id)
    or (
      is_org_member(organization_id)
      and status <> 'on_review'
      and (
        project_id is null
        or submitted_by = auth.uid()
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
          project_id is null
          or submitted_by = auth.uid()
          or is_eligible_approver(id, auth.uid())
        )
      )
    )
    and not is_org_auditor(organization_id)
  );

-- Now safe to drop — the policies above were the last things referencing it.
alter table approval_workflow_steps drop column if exists approver_user_id;

-- ---------------------------------------------------------------------
-- approval_workflow_projects is no longer used for anything — visibility
-- is condition-based now, not project-link-based. Dropping the table also
-- drops its own policies automatically, so there's nothing to do first —
-- an explicit `drop policy ... on approval_workflow_projects` would fail
-- on a second run once the table itself is already gone (unlike `drop
-- policy if exists`, `if exists` only guards the policy name, not the
-- table it's on).
-- ---------------------------------------------------------------------

drop table if exists approval_workflow_projects;
