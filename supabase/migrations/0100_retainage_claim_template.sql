-- A saved template for the holdback claim email.
--
-- The standard wording can't know a customer's own instructions —
-- "email your invoice to ap@theircompany.ca", "quote the PO number",
-- "invoices received after the 25th go in next month's run" — and
-- retyping them on every send is how they end up inconsistent or
-- forgotten. Saved once per org, pre-filled into the dialog, still
-- editable for a particular send.
--
-- retainage_claim_to_email is where subcontractors should send the
-- invoice. It defaults, in the UI, to the org's own inbound invoice
-- address, which is the useful answer: an invoice mailed there is
-- ingested and extracted by Flow automatically, so the claim comes back
-- into the same system that asked for it. A customer who wants it going
-- somewhere else can say so.
--
-- Authored by Araza.

alter table organizations
  add column if not exists retainage_claim_note text,
  add column if not exists retainage_claim_to_email text;

comment on column organizations.retainage_claim_note is
  'Saved default body text added to the holdback claim email. Pre-fills the send dialog; editable per send.';
comment on column organizations.retainage_claim_to_email is
  'Where subcontractors should email their holdback invoice. Defaults in the UI to the org inbound address so the claim is ingested automatically.';
