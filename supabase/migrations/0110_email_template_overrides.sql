-- Per-org overrides for the copy of specific outbound emails — "if a
-- customer wants to pay extra for their own wording/branding on an
-- email." Platform-admin-only, never exposed to a customer's own org
-- admin: RLS is enabled with NO policies at all, the same pattern as
-- feature_flags/platform_config/qbo_bill_import_jobs — every read and
-- write goes through the admin client from a platform-admin-gated
-- server action (see src/lib/email-templates.ts,
-- saveEmailTemplateOverride in admin-actions.ts).
--
-- Structured fields, not raw HTML — the shell/layout (emailShell in
-- notify.ts) stays fixed, only the copy and a couple of style knobs
-- change, so an edit here can never break an email's markup.
--
-- Authored by Araza.

create table email_template_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Which built-in email this overrides — see TEMPLATE_DEFS in
  -- src/lib/email-templates.ts for the current set and their available
  -- {{tokens}}.
  template_key text not null,
  subject text,
  eyebrow text,
  headline text,
  -- May contain {{tokens}} (e.g. {{orgName}}) substituted at send time —
  -- see renderTemplate.
  body text,
  accent_color text,
  cta_label text,
  cta_url text,
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, template_key)
);

alter table email_template_overrides enable row level security;
