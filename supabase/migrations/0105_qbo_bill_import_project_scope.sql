-- Scope an import to one project, not just a date range.
--
-- "The job we're still working on is three years old — I don't want
-- three years of everything, just that project's invoices." QBO's query
-- language can't do this server-side: CustomerRef (project) lives on
-- each Bill LINE, not the Bill header, and only header-level fields are
-- queryable. So this is a post-fetch filter, not a smarter query — the
-- date range still bounds what gets paged through; the project narrows
-- what actually gets imported out of that range.
--
-- Authored by Araza.

alter table qbo_bill_import_jobs
  add column if not exists project_id uuid references projects(id) on delete set null;

comment on column qbo_bill_import_jobs.project_id is
  'Optional: only import bills with at least one line on this project. Filtered after fetching, since QBO cannot query Bill by line-level CustomerRef. Null imports everything in the date range.';
