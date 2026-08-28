-- 0074: organizations.stripe_customer_id -- the persistent Stripe Customer
-- behind an org, created lazily (first "Pay now" or "Manage billing" click)
-- rather than up front. Without a persisted customer, every Checkout
-- session was anonymous, so Stripe had nothing to point a Billing Portal
-- session at — there was no way for a customer to see past receipts or
-- update a saved payment method themselves.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table organizations add column if not exists stripe_customer_id text;
