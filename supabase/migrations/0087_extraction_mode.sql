alter table organizations
  add column if not exists extraction_mode text not null default 'detailed'
  check (extraction_mode in ('detailed', 'simple'));
