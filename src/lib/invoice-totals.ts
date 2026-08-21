// Single source of truth for "what does this invoice actually add up
// to" — used both when an invoice first lands (from the extracted line
// items) and whenever a line item is added, edited, or removed in the
// Bill panel. Tax is calculated per line as amount × tax rate%, with a
// blank/null rate contributing no tax for that line — not a single
// whole-invoice tax figure lifted from the document. Authored by Araza.

export interface TotalableLineItem {
  amount: number | null;
  tax_rate?: number | null;
}

export function computeLineItemTotals(lineItems: TotalableLineItem[]): {
  subtotal: number;
  tax: number;
  total: number;
} {
  const subtotal = lineItems.reduce((sum, li) => sum + (li.amount ?? 0), 0);
  const tax = lineItems.reduce(
    (sum, li) => sum + (li.amount ?? 0) * ((li.tax_rate ?? 0) / 100),
    0
  );
  return { subtotal, tax, total: subtotal + tax };
}
