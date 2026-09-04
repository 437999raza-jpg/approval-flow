-- "We have to build it" — a customer paying for usage is a manual
-- "Pay now" click on the Billing page (a one-off Stripe Checkout
-- session, not a recurring subscription — there is no subscription
-- object in this app's Stripe integration at all). Nothing today
-- tracks whether that's actually happened recently, so a customer who
-- simply stops clicking "Pay now" is indistinguishable from one who
-- pays every month — isOrgLocked() only checks trial-end and whether a
-- plan is SELECTED, never whether it's been PAID for.
--
-- usage_last_paid_at is stamped by the new Stripe webhook
-- (checkout.session.completed) rather than the existing
-- redirect-only confirmation, which silently loses the payment if the
-- customer closes the tab before the redirect lands.
--
-- usage_reminder_sent_at guards the reminder cron so it nudges once,
-- not every single day the org stays unpaid.
--
-- Backfill: an existing customer who has simply never had this
-- tracked yet should not look instantly 35+ days overdue the moment
-- this ships — start their clock from when they picked their plan.
--
-- Authored by Araza.

alter table organizations add column if not exists usage_last_paid_at timestamptz;
alter table organizations add column if not exists usage_reminder_sent_at timestamptz;

update organizations
set usage_last_paid_at = coalesce(plan_selected_at, now())
where usage_last_paid_at is null and plan is not null;
