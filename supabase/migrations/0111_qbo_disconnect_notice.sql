-- "Do we have something like this for clients" (reported live, next to
-- an ApprovalMax screenshot: "Your Organisation has been disconnected
-- from QuickBooks Online"). Today a dead refresh token just makes
-- getQboConnection() silently return null — every QBO-dependent
-- feature (sync, category/supplier refresh) quietly stops working with
-- nobody told. This column marks the moment we detected the break, so
-- we notify the org's admins exactly once instead of either staying
-- silent or re-emailing on every single failed call.
--
-- Authored by Araza.

alter table qbo_connections add column if not exists disconnected_at timestamptz;
