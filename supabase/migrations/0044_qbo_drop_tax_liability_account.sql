-- 0044: undo 0043. Testing showed a per-org "Sales Tax Liability Account"
-- was the wrong approach -- QBO already calculates and posts sales tax
-- itself once a bill line carries a native TaxCodeRef; Flow manually
-- posting a "Tax" line to a configured account double-handled tax and
-- posted to the wrong kind of account (a liability for tax the business
-- COLLECTS on sales, not tax it PAYS to a vendor on a bill). Sales tax is
-- now represented via TaxCodeRef, resolved from the existing qbo_tax_codes
-- mirror (see resolveTaxCode/matchTaxCode in src/lib/qbo.ts) -- no
-- per-org account configuration needed at all.
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table qbo_connections drop column if exists tax_liability_account_id;
