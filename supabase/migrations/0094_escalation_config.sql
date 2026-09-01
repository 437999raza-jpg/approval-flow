-- Makes escalation match how an organization is actually shaped, instead
-- of hardcoding it. Three independent additions, all additive and all
-- with defaults that reproduce today's behavior exactly, so nothing
-- changes until someone configures it.
--
-- Why not a manager/reporting-line column on members: seniority isn't a
-- fixed direction here. The same two people appear in both orders —
-- manager-then-subordinate in one workflow, subordinate-then-manager in
-- another — so "escalate upward" would be wrong half the time. The
-- escalation target belongs to the STEP (a position in a flow), which is
-- where the org structure is already expressed, rather than to a person.

-- 1. Who to notify when a step blows past its deadline. Null keeps the
--    current behavior: every admin in the org gets paged.
alter table approval_workflow_steps
  add column if not exists escalate_to_user_id uuid references auth.users(id) on delete set null;

comment on column approval_workflow_steps.escalate_to_user_id is
  'Who receives the escalation email when this step goes past deadline + the org grace period. Null = all org admins (the default before this column existed).';

-- 2. Grace period after a step's deadline before escalating, per org.
--    2 matches the ESCALATION_GRACE_DAYS constant this replaces.
alter table organizations
  add column if not exists escalation_grace_days integer not null default 2;

alter table organizations
  drop constraint if exists organizations_escalation_grace_days_check;
alter table organizations
  add constraint organizations_escalation_grace_days_check
  check (escalation_grace_days >= 0 and escalation_grace_days <= 60);

-- 3. Stand-in cover while someone is away. Per membership, not per user:
--    the same person can be in several orgs and be covered by a
--    different colleague in each. This is the piece that prevents a
--    stall rather than reacting to one — an approver on holiday is the
--    single most common reason a step sits untouched, and no escalation
--    policy fixes that on its own.
alter table organization_members
  add column if not exists substitute_user_id uuid references auth.users(id) on delete set null;

-- Null = cover indefinitely until cleared. A date = auto-expires, so
-- nobody has to remember to switch it off after a holiday.
alter table organization_members
  add column if not exists substitute_until date;

-- Covering for yourself is a no-op that would silently look like it
-- worked, so reject it outright.
alter table organization_members
  drop constraint if exists organization_members_substitute_not_self;
alter table organization_members
  add constraint organization_members_substitute_not_self
  check (substitute_user_id is null or substitute_user_id <> user_id);

comment on column organization_members.substitute_user_id is
  'While set (and substitute_until is null or not yet passed), this person stands in for the member everywhere approvals route: who may approve, who is shown as currently holding, and who receives reminders.';
