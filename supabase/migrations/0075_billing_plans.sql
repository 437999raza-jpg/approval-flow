-- 0075: organizations.plan -- which of Flow's three fixed monthly plans
-- (Starter/Growth/Scale, see src/lib/plans.ts) an org is on. Replaces the
-- old admin-editable "$/document" rate model (usage_rate_usd, still on
-- the table but no longer read by the Billing page) with fixed
-- plan+included-docs+overage-rate tiers, matching how comparable tools
-- (ApprovalMax, Dext) price. Null = no plan chosen yet.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists plan text;

alter table organizations drop constraint if exists organizations_plan_check;
alter table organizations add constraint organizations_plan_check
  check (plan is null or plan in ('starter', 'growth', 'scale'));

alter table organizations add column if not exists plan_selected_at timestamptz;
