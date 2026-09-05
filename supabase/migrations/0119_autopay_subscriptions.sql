-- Real auto-charging Stripe subscriptions, opt-in alongside the existing
-- manual "Pay now" checkout (never removed, no deadline — see the plan
-- doc). One subscription per org covers the base plan price;
-- overage is billed separately as a Stripe invoice item once each
-- completed month's usage is known (src/app/api/cron/billing-reminders).
--
-- last_overage_billed_month (e.g. "2026-09") is the idempotency guard
-- that stops the daily cron from ever double-billing the same month.
-- subscription_payment_failed_at follows the same throttled-renotify
-- pattern as usage_reminder_sent_at — notify, never lock (v1).
--
-- Authored by Araza.

alter table organizations
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_subscription_item_id text,
  add column if not exists autopay_enabled boolean not null default false,
  add column if not exists last_overage_billed_month text,
  add column if not exists subscription_payment_failed_at timestamptz;
