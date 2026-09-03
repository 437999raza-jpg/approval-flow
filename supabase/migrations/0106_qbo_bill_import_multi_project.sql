-- Scope an import to several jobs at once, not just one.
--
-- Migration 0105 added a single project_id. Nothing has used it yet
-- (table confirmed empty), so replacing it outright rather than
-- maintaining both a singular and a plural column. project_ids is a
-- plain array with no foreign key — Postgres arrays can't carry one —
-- consistent with match_values text[] elsewhere in this schema, which
-- has the same limitation for the same reason.
--
-- Authored by Araza.

alter table qbo_bill_import_jobs drop column if exists project_id;
alter table qbo_bill_import_jobs add column if not exists project_ids uuid[] not null default '{}';

comment on column qbo_bill_import_jobs.project_ids is
  'Optional: only import bills with at least one line on any of these projects. Filtered after fetching, since QBO cannot query Bill by line-level CustomerRef. Empty imports everything in the date range.';
