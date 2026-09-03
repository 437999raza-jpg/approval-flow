-- Historical bill import from QuickBooks — a platform-admin-only tool,
-- never exposed to a customer's own Settings. Araza runs this by hand
-- when onboarding a paying customer who wants their pre-Flow QuickBooks
-- history brought in, as a paid service on top of the base product.
--
-- One row per import request (an org + a date range), processed in
-- batches by a cron tick rather than one request — a real backlog can be
-- hundreds of bills, each needing its own line-item resolution and
-- attachment downloads, well past what one HTTP request should attempt.
-- cursor_position is QBO's own query STARTPOSITION, so a batch always
-- resumes exactly where the last one left off.
--
-- Authored by Araza.

create table if not exists qbo_bill_import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  date_from date not null,
  date_to date not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'error')),
  cursor_position int not null default 1,
  imported_count int not null default 0,
  skipped_count int not null default 0,
  failed_count int not null default 0,
  -- Short, human-readable notes on why bills were skipped/failed, capped
  -- to the last few so this never grows unbounded on a large backlog.
  notes text[] not null default '{}',
  last_error text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists qbo_bill_import_jobs_active_idx
  on qbo_bill_import_jobs (organization_id)
  where status in ('queued', 'processing');

alter table qbo_bill_import_jobs enable row level security;

-- No org-member policy at all, deliberately: this table is read and
-- written exclusively through the admin client from platform-admin-only
-- server actions (see src/lib/qbo-bill-import.ts), the same pattern
-- feature_flags and platform_config use. A customer's own admin should
-- never be able to see or trigger this, even by discovering the table.
