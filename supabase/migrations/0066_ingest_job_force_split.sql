-- 0066: ingest_jobs.force_split -- carries the [1N]/[NM] subject-code
-- "force split review" decision through to a queued job. Previously this
-- only applied when an attachment was processed inline in the email
-- webhook; a job that fell back to the queue (or, after the durability
-- fix that made EVERY attachment go through the queue, every job) never
-- got this flag at all -- silently dropping the force-split behavior for
-- that document. Read by runNextIngestJob and passed to ingestInvoiceFile.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table ingest_jobs add column if not exists force_split boolean not null default false;
