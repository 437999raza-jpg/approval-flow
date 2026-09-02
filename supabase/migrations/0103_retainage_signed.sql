-- The retainage ledger holds signed amounts.
--
-- The account has two directions: withholding posts a credit, and the
-- subcontractor's later invoice claiming it back posts the matching
-- debit. Both belong in the ledger — a vendor's balance is the sum, and
-- zero means they have invoiced for everything held. The original
-- check (amount > 0) could only store one half of that.
--
-- Positive here means "still held from them", matching how the QBO
-- report reads, so summing the column is the answer without a case
-- statement anywhere.
--
-- Authored by Araza.

alter table invoice_retainage
  drop constraint if exists invoice_retainage_amount_check;

comment on column invoice_retainage.amount is
  'Signed. Positive = withheld from the vendor, negative = they invoiced it back. A vendor nets to zero once they have claimed everything held.';
