-- Superseded by deriving extraction mode from plan (see extractionModeForOrg
-- in src/lib/plans.ts) instead of a separate per-org switch — one lever
-- (plan) now decides both billing and extraction depth, so they can't drift.
alter table organizations drop column if exists extraction_mode;
