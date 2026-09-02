-- Custom plans and one-time setup fees.
--
-- Flow's four fixed plans (src/lib/plans.ts) don't fit the bespoke work
-- that is most of what we actually sell: a client negotiates their own
-- monthly price and volume, and pays a one-time fee for us to build the
-- product around their process. Both were being handled outside the app
-- entirely (a hand-written invoice), which meant the Billing page showed
-- those orgs a plan grid that had nothing to do with what they'd agreed.
--
-- custom_plan is JSONB rather than five more columns because it is a
-- negotiated snapshot, not a schema: it's written once by a platform
-- admin from /admin/organizations, read back through parseCustomPlan()
-- in src/lib/plans.ts (which validates the shape defensively, since
-- JSONB gives no guarantees), and never queried against. Adding a
-- capability to a future custom deal shouldn't cost a migration.
--
-- The setup fee lives in its own columns instead, because it applies to
-- standard-plan customers too — a Growth customer can still pay for a
-- custom build — and because setup_fee_paid_at is real billing state
-- that gets read and written on its own.
--
-- Authored by Araza.

alter table organizations
  add column if not exists custom_plan jsonb,
  add column if not exists setup_fee_usd numeric(10, 2),
  add column if not exists setup_fee_label text,
  add column if not exists setup_fee_paid_at timestamptz;

-- A negative or absurd fee is a typo in the admin form, not a deal.
alter table organizations
  drop constraint if exists organizations_setup_fee_usd_check;
alter table organizations
  add constraint organizations_setup_fee_usd_check
  check (setup_fee_usd is null or (setup_fee_usd >= 0 and setup_fee_usd <= 1000000));

-- Paid-but-no-fee is incoherent state; catch it at the boundary rather
-- than teaching every reader to ignore it.
alter table organizations
  drop constraint if exists organizations_setup_fee_paid_check;
alter table organizations
  add constraint organizations_setup_fee_paid_check
  check (setup_fee_paid_at is null or setup_fee_usd is not null);

comment on column organizations.custom_plan is
  'Negotiated per-org plan overriding organizations.plan. Shape validated by parseCustomPlan() in src/lib/plans.ts: {name, priceUsd, includedDocs, overageRatePerDoc, blurb?, statementReconciliation?, extraction?}. Platform-admin write only.';
comment on column organizations.setup_fee_usd is
  'One-time build/onboarding fee in USD. Independent of plan — a standard-plan org can owe one too.';
comment on column organizations.setup_fee_paid_at is
  'Set when the setup fee is collected: automatically on return from Stripe Checkout, or by hand from /admin/organizations when invoiced outside Stripe.';
