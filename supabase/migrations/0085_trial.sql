-- 0085: a 14-day self-serve trial. null = no trial (every org made via
-- the platform-admin /admin/organizations flow, or one that already
-- picked a plan before this shipped).
alter table organizations add column if not exists trial_ends_at timestamptz;
