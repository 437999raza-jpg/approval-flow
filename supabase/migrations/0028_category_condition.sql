-- Adds "Category" as a fourth condition field for step approvers, alongside
-- Class/Supplier/Customer (0027) — matches invoice_line_items.category the
-- same way Class matches invoice_line_items.class. Authored by Araza.
-- Idempotent — safe to re-run.

alter table approval_workflow_step_conditions
  drop constraint if exists approval_workflow_step_conditions_field_check;
alter table approval_workflow_step_conditions
  add constraint approval_workflow_step_conditions_field_check
  check (field in ('class', 'customer', 'supplier', 'category'));

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
  v_categories text[];
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

  select coalesce(array_agg(distinct lower(trim(category))) filter (where category is not null and trim(category) <> ''), '{}')
    into v_categories
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
      elsif r_cond.field = 'category' then
        if r_cond.operator = 'matches' and not (v_categories && v_cond_values) then
          approver_ok := false;
        elsif r_cond.operator = 'not_matches' and (v_categories && v_cond_values) then
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
