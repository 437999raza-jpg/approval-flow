-- Fourth plan tier: "Detailed" at $299/mo — the top of the ladder,
-- positioned as today's line-by-line extraction product, and the plan
-- that gates Statement Reconciliation (see 0081).
alter table organizations drop constraint if exists organizations_plan_check;
alter table organizations add constraint organizations_plan_check
  check (plan is null or plan in ('starter', 'growth', 'scale', 'detailed'));
