-- Per-org on/off switch for bulk-approve (select several pending
-- invoices in the dashboard, approve them all at once). Built as an
-- explicit org-level flag rather than baked in unconditionally, per
-- request — this may become a plan-gated / marketed feature later, and
-- a flag that's already there today just needs a value flipped, not new
-- plumbing. Defaults on so nothing changes for any existing org until
-- someone deliberately turns it off from /admin/organizations.
--
-- Authored by Araza.

alter table organizations
  add column if not exists bulk_approve_enabled boolean not null default true;
