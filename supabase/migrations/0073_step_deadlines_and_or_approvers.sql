-- Fills two gaps found comparing a real ApprovalMax workflow export
-- against this app: (1) a single approver couldn't be given two
-- alternative rule sets ("approve if Customer X and Supplier Y, OR if
-- Class Z") because approval_workflow_step_approvers had a hard
-- unique(step_id, approver_user_id); (2) there was no per-step deadline,
-- so nothing ever flagged an invoice sitting too long with one approver.
--
-- (1) is a pure constraint drop — effectiveApproversForStep() (TS) and
-- is_eligible_approver() (SQL) already loop over every row for a given
-- approver on a step and return them as eligible if ANY row's conditions
-- match, so adding the same person twice with two different condition
-- sets already behaves as an OR. Only the constraint blocked it, and
-- the workflows UI's approver dropdown was never filtered to exclude
-- already-added people, so no UI change is needed either.
--
-- (2) adds approval_workflow_steps.deadline_days (null = no deadline,
-- current behavior) plus the bookkeeping columns on invoices the daily
-- reminder/escalation cron (src/app/api/cron/reminders/route.ts) needs:
-- current_step_entered_at (the clock "days on this step" is measured
-- from — reset by every code path that changes current_step_order) and
-- escalated_at (so a stuck invoice pages admins once, not on every run
-- of the daily cron).
--
-- Authored by Araza. Idempotent — safe to re-run.

alter table approval_workflow_step_approvers
  drop constraint if exists approval_workflow_step_approvers_step_id_approver_user_id_key;

alter table approval_workflow_steps
  add column if not exists deadline_days int;

alter table approval_workflow_steps
  drop constraint if exists approval_workflow_steps_deadline_days_check;
alter table approval_workflow_steps
  add constraint approval_workflow_steps_deadline_days_check
  check (deadline_days is null or deadline_days > 0);

alter table invoices
  add column if not exists current_step_entered_at timestamptz not null default now();
alter table invoices
  add column if not exists escalated_at timestamptz;
